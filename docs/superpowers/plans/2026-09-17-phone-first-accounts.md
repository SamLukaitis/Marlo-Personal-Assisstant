# Phone-First Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a WhatsApp phone number create a Marlowe account on its own, with Google/Microsoft OAuth demoted to an optional feature linked later.

**Architecture:** Relax `users.email` to nullable via a transaction-wrapped table rebuild, add `findOrCreateUserByPhone`, and make the existing onboarding "No" branch create a real account instead of parking the state machine. Everything downstream already keys on `owner_id`, so no other table changes.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Express, better-sqlite3 11.10, Vitest, React (client).

**Spec:** `docs/superpowers/specs/2026-09-17-phone-first-accounts-design.md`

## Global Constraints

- Branch: `feat/phone-first-accounts`, off `master`. Already created.
- Imports use `.js` specifiers even for `.ts` files (ESM). Match surrounding style.
- `PRAGMA foreign_keys` is ON by default (better-sqlite3's default, never overridden in `store.ts`). The `users` rebuild is the one place that has to disable it around its own transaction and restore it in `finally` — `DROP TABLE users` is a parent-table drop with 29 FK-enforced children. No other task should change this setting.
- Migrations run at module load in `store.ts`. Anything added there executes on every boot and must be idempotent.
- Tests: `cd server && npx vitest run <path>`. Full suite: `npx vitest run`. Typecheck: `npx tsc --noEmit` in both `server/` and `client/`.
- The repo comments *why*, not *what*. Match that register — explain reasoning a future reader would otherwise have to reconstruct.
- Never enable `db.exec()` multi-statement DDL for destructive migrations. Use `db.transaction(...)`.
- Commit after each task. End commit messages with the attribution lines used on this branch's existing commits.

---

### Task 1: Make `users.email` nullable

> **SUPERSEDED — see the shipped migration and Ruling 2 in the ledger.** The migration code
> embedded below predates the foreign-keys fix: it assumes `PRAGMA foreign_keys` is OFF, which
> the ledger's Ruling 2 found to be false (better-sqlite3 defaults it ON and nothing in `store.ts`
> disables it). What actually shipped — including the `foreign_keys` toggle around the rebuild
> transaction, the Proxy-tested row-count guard from Ruling 3, and the before/after
> `foreign_key_check` comparison from Ruling 4 — lives in
> `server/src/db/migrations/usersEmailNullable.ts`. This section is left as-written for history;
> do not follow it as instructions.

The sharp edge of the whole feature. Extracted into its own module because `store.ts` runs migrations at module-load time against a fresh temp DB per test run — there is no way to test an in-place migration from the normal harness, since the schema is created new. A standalone function taking a `Database` lets a test build the *old* schema deliberately and run the migration against it.

**Files:**
- Create: `server/src/db/migrations/usersEmailNullable.ts`
- Create: `server/src/db/migrations/usersEmailNullable.test.ts`
- Modify: `server/src/db/store.ts:87-91` (base CREATE TABLE), `server/src/db/store.ts:301-303` (call site, after the `is_admin` block)

**Interfaces:**
- Consumes: nothing.
- Produces: `migrateUsersEmailNullable(db: Database.Database): void` — idempotent; no-op when `email` is already nullable.

- [ ] **Step 1: Write the failing test**

Create `server/src/db/migrations/usersEmailNullable.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrateUsersEmailNullable } from "./usersEmailNullable.js";

// The pre-migration shape, exactly as store.ts created it before this migration existed —
// including the is_admin column that an earlier ALTER adds, since the rebuild must carry it.
function buildLegacyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  `);
  return db;
}

function emailIsNullable(db: Database.Database): boolean {
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string; notnull: number }[];
  return cols.find((c) => c.name === "email")?.notnull === 0;
}

describe("migrateUsersEmailNullable", () => {
  it("relaxes NOT NULL on email", () => {
    const db = buildLegacyDb();
    expect(emailIsNullable(db)).toBe(false);

    migrateUsersEmailNullable(db);

    expect(emailIsNullable(db)).toBe(true);
  });

  it("preserves every existing row verbatim, including ids and is_admin", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(1, "owner@example.com", 1000, 1);
    db.prepare(`INSERT INTO users (id, email, created_at, is_admin) VALUES (?, ?, ?, ?)`).run(7, "tester@example.com", 2000, 0);

    migrateUsersEmailNullable(db);

    const rows = db.prepare(`SELECT id, email, created_at AS createdAt, is_admin AS isAdmin FROM users ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 1, email: "owner@example.com", createdAt: 1000, isAdmin: 1 },
      { id: 7, email: "tester@example.com", createdAt: 2000, isAdmin: 0 },
    ]);
  });

  it("accepts a NULL email after migrating, and still rejects a duplicate address", () => {
    const db = buildLegacyDb();
    migrateUsersEmailNullable(db);

    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run(null, 1000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run(null, 2000);
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("real@example.com", 3000);

    // Multiple NULLs are fine in a SQLite UNIQUE column — that is what makes this design work.
    expect(db.prepare(`SELECT count(*) AS n FROM users WHERE email IS NULL`).get()).toEqual({ n: 2 });
    expect(() =>
      db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("real@example.com", 4000)
    ).toThrow();
  });

  it("is idempotent — a second run changes nothing", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("owner@example.com", 1000);

    migrateUsersEmailNullable(db);
    migrateUsersEmailNullable(db);

    expect(emailIsNullable(db)).toBe(true);
    expect(db.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
  });

  it("rolls back and leaves the original table intact if the copy is short", () => {
    const db = buildLegacyDb();
    db.prepare(`INSERT INTO users (email, created_at) VALUES (?, ?)`).run("owner@example.com", 1000);
    // Force the row-count guard to trip by leaving a stale users_new behind with a conflicting
    // row, so the INSERT...SELECT cannot copy everything.
    db.exec(`CREATE TABLE users_new (id INTEGER PRIMARY KEY, email TEXT, created_at INTEGER, is_admin INTEGER)`);

    expect(() => migrateUsersEmailNullable(db)).toThrow();

    // The original table survived the failure — this is the property that matters most.
    expect(db.prepare(`SELECT count(*) AS n FROM users`).get()).toEqual({ n: 1 });
    expect(emailIsNullable(db)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/migrations/usersEmailNullable.test.ts`
Expected: FAIL — cannot find module `./usersEmailNullable.js`.

- [ ] **Step 3: Write the migration**

Create `server/src/db/migrations/usersEmailNullable.ts`:

```typescript
import type Database from "better-sqlite3";

// Phone-first accounts (docs/superpowers/specs/2026-09-17-phone-first-accounts-design.md) need a
// users row with no email, but the column shipped as `email TEXT NOT NULL UNIQUE` and SQLite
// cannot relax NOT NULL in place — the column has to be rebuilt.
//
// UNIQUE is kept deliberately: SQLite allows any number of NULLs in a unique column, so
// phone-only accounts coexist while two accounts still cannot share a real address.
//
// Unlike the api_usage rebuild in store.ts, this runs inside db.transaction(). That is not
// stylistic. CREATE -> copy -> DROP -> RENAME has a window where `users` does not exist, and
// these migrations run unattended at boot; a container killed inside that window would leave a
// database with no users table and 29 tables of rows keyed to owner ids that resolve to nothing.
// SQLite's DDL is transactional, so wrapping it makes a crash a no-op instead of a catastrophe.
export function migrateUsersEmailNullable(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(users)`).all() as { name: string; notnull: number }[];
  const email = columns.find((c) => c.name === "email");
  // Already nullable (or a fresh database created from the current schema) — nothing to do.
  if (!email || email.notnull === 0) return;

  const rebuild = db.transaction(() => {
    const before = (db.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n;

    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new (id, email, created_at, is_admin)
        SELECT id, email, created_at, is_admin FROM users;
    `);

    // Verified BEFORE the drop, inside the transaction: a short copy throws, the transaction
    // rolls back, and the original table is still there. Without this a silent partial copy
    // would be made permanent by the DROP on the next line.
    const after = (db.prepare(`SELECT count(*) AS n FROM users_new`).get() as { n: number }).n;
    if (after !== before) {
      throw new Error(`users rebuild copied ${after} of ${before} rows — refusing to drop the original`);
    }

    db.exec(`
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  });

  rebuild();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/db/migrations/usersEmailNullable.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Make fresh databases nullable too, and wire up the call**

In `server/src/db/store.ts`, change the base table at line 87 so a brand-new database is created correct and skips the migration entirely:

```sql
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    created_at INTEGER NOT NULL
  );
```

Add the import at the top of `store.ts`, alongside the other imports:

```typescript
import { migrateUsersEmailNullable } from "./migrations/usersEmailNullable.js";
```

Then call it immediately after the `is_admin` block that ends at line 303 — the order matters, because the rebuild copies `is_admin` and that column must exist first:

```typescript
// Must run AFTER the is_admin ALTER above: the rebuild copies that column, so it has to exist
// before the copy. Phone-first accounts need a users row with no email — see the migration's own
// comment for why this one is transaction-wrapped when the api_usage rebuild below is not.
migrateUsersEmailNullable(db);
```

- [ ] **Step 6: Back up the database file before any migration runs**

Still in `store.ts`, immediately after `const db = new Database(...)` at line 17:

```typescript
// Written before any migration touches the schema. The rebuild in migrations/usersEmailNullable.ts
// is transaction-wrapped and safe, but nothing in this codebase has ever backed this file up, and
// it is the only copy of every account on a Railway volume. Best-effort: a backup that fails must
// not stop the server booting, and `.bak` files are small enough to leave for a human to clear.
const backupPath = path.join(dataDir, `app.db.bak-${Date.now()}`);
try {
  db.backup(backupPath).catch((err) => console.error("store: pre-migration backup failed", err));
} catch (err) {
  console.error("store: pre-migration backup failed", err);
}
```

- [ ] **Step 7: Run the full server suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass. Existing tests build a fresh DB, so the migration is a no-op for them — that is the intended outcome, and proves the guard works.

- [ ] **Step 8: Commit**

```bash
git add server/src/db/migrations/ server/src/db/store.ts
git commit -m "feat: make users.email nullable for phone-first accounts"
```

---

### Task 2: Teach the codebase that an account may have no email

Pure type-safety work, no behaviour change. Done *before* anything can create a NULL row, so the compiler — not a human reading 3,000 lines — finds every site that needs a decision.

**Files:**
- Modify: `server/src/db/store.ts:2491-2495` (`UserRow`), `:2597-2603` (`AdminCandidateRow`)
- Modify: `server/src/routes/meRoutes.ts:23`
- Modify: `client/src/api/client.ts` (the `User` shape with `isAppOwner`/`isAdmin`, ~line 40)
- Modify: whatever else `tsc` reports

**Interfaces:**
- Consumes: Task 1's nullable column.
- Produces: `UserRow.email: string | null`, `AdminCandidateRow.email: string | null`, and `/api/me`'s `email` field nullable in the client's `User` type.

**The rendering rule** for every display site: show `"No email connected"` for a null. Never `"null"`, never an empty string, never a fabricated placeholder address.

- [ ] **Step 1: Widen the types**

In `server/src/db/store.ts`, `UserRow`:

```typescript
export interface UserRow {
  id: number;
  // null for a phone-first account that has never linked a mailbox — see
  // findOrCreateUserByPhone. Every read site must handle it rather than assuming a real address.
  email: string | null;
  createdAt: number;
}
```

And `AdminCandidateRow`:

```typescript
export interface AdminCandidateRow {
  id: number;
  email: string | null;
  isAdmin: boolean;
  isAppOwner: boolean;
  createdAt: number;
}
```

Also widen the inline row type on the `listAdminCandidates` query (`store.ts:2610-2611`) from `{ id: number; email: string; ... }` to `{ id: number; email: string | null; ... }`.

- [ ] **Step 2: Run the typechecker and collect the work**

Run: `cd server && npx tsc --noEmit`
Expected: FAIL, with a list of sites that assumed a string. Work through them in the order reported.

Known sites, so none are missed if the compiler is lenient:
- `server/src/routes/meRoutes.ts:23` — pass `email: user.email` straight through; the field is nullable end to end.
- `server/src/db/store.ts:2899, 2908, 2993` — portal to-do/note joins selecting `u.email AS createdByEmail` / `authorEmail`. Widen those row types to `string | null` too; they join to `users` and inherit the same nullability.
- `normalizeEmail` (`store.ts:2499`) and `findOrCreateUserByEmail` / `getUserByEmail` keep taking and returning non-null `string` parameters — they are the *email* paths and are unaffected.

- [ ] **Step 3: Fix each site, then the client**

In `client/src/api/client.ts`, widen `email` on the user shape returned by `/api/me` to `string | null`. Then run `cd client && npx tsc --noEmit` and fix any render site the compiler flags, using the rendering rule above.

For a display site, the shape to use:

```typescript
{user.email ?? "No email connected"}
```

- [ ] **Step 4: Verify both typecheck and the suite still passes**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Then: `cd client && npx tsc --noEmit`
Expected: all clean, all tests pass. No test should have needed changing — this task changes no behaviour.

- [ ] **Step 5: Commit**

```bash
git add -A server/src client/src
git commit -m "refactor: allow a user row to have no email"
```

---

### Task 3: `findOrCreateUserByPhone`

**Files:**
- Modify: `server/src/db/store.ts` (add next to `findOrCreateUserByEmail`, ~line 2506)
- Create: `server/src/db/usersByPhone.test.ts`

**Interfaces:**
- Consumes: Task 1's nullable column, Task 2's `UserRow.email: string | null`.
- Produces: `findOrCreateUserByPhone(phone: string): UserRow` — creates a `users` row with `email = null` and binds the phone, or returns the existing owner if the number is already bound.

- [ ] **Step 1: Write the failing test**

Create `server/src/db/usersByPhone.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  resolveOwnerByPhone,
  getUser,
} from "./store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44790000${String(counter).padStart(4, "0")}`;
}

describe("findOrCreateUserByPhone", () => {
  it("creates an account with no email and binds the phone to it", () => {
    const phone = freshPhone();

    const user = findOrCreateUserByPhone(phone);

    expect(user.email).toBeNull();
    expect(resolveOwnerByPhone(phone)).toBe(user.id);
    expect(getUser(user.id)?.email).toBeNull();
  });

  it("returns the existing owner instead of creating a second account", () => {
    const phone = freshPhone();
    const first = findOrCreateUserByPhone(phone);

    const second = findOrCreateUserByPhone(phone);

    expect(second.id).toBe(first.id);
  });

  it("returns the existing owner when the number already belongs to an email account", () => {
    const phone = freshPhone();
    const existing = findOrCreateUserByEmail(`linked-${phone}@example.com`);
    addPhoneNumberForUser(existing.id, phone);

    const resolved = findOrCreateUserByPhone(phone);

    expect(resolved.id).toBe(existing.id);
    expect(resolved.email).toBe(`linked-${phone}@example.com`);
  });

  it("gives two different numbers two different accounts", () => {
    const a = findOrCreateUserByPhone(freshPhone());
    const b = findOrCreateUserByPhone(freshPhone());

    expect(a.id).not.toBe(b.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/db/usersByPhone.test.ts`
Expected: FAIL — `findOrCreateUserByPhone` is not exported.

- [ ] **Step 3: Implement**

In `server/src/db/store.ts`, directly after `findOrCreateUserByEmail`:

```typescript
// The phone-first counterpart to findOrCreateUserByEmail: a WhatsApp number is enough to own an
// account, with email attached later if the person ever wants inbox/calendar help. The row is
// created with a null email deliberately — see migrations/usersEmailNullable.ts.
//
// Wrapped in a transaction so a crash between the users INSERT and the phone binding cannot leave
// an orphaned, unreachable account: resolveOwnerByPhone is the only way back to this row, so a
// half-written pair would be invisible to every caller and silently re-created on the next message.
export function findOrCreateUserByPhone(phone: string): UserRow {
  const normalized = normalizePhone(phone);
  const existingOwner = resolveOwnerByPhone(normalized);
  if (existingOwner !== null) {
    return getUser(existingOwner) as UserRow;
  }

  const create = db.transaction(() => {
    const info = db.prepare(`INSERT INTO users (email, created_at) VALUES (NULL, ?)`).run(Date.now());
    const userId = Number(info.lastInsertRowid);
    addPhoneNumberForUser(userId, normalized);
    return getUser(userId) as UserRow;
  });

  return create();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/db/usersByPhone.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/store.ts server/src/db/usersByPhone.test.ts
git commit -m "feat: create an account from a phone number alone"
```

---

### Task 4: Make the onboarding "No" branch create the account

The task that fixes the live bug. After this, tapping No produces a working account and the next message reaches the assistant.

**Files:**
- Modify: `server/src/services/whatsappRegistration.ts:238-257` (`handleEmailConfirmTap`)
- Modify: `server/src/services/whatsappRegistration.test.ts`
- Delete: `feature-to-do/email-less-accounts.md`

**Interfaces:**
- Consumes: `findOrCreateUserByPhone` from Task 3.
- Produces: an account reachable by `resolveOwnerByPhone` immediately after the No tap.

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/whatsappRegistration.test.ts`. Note the existing file already imports `handlePendingRegistration`, `getPendingRegistration`, `upsertPendingRegistration` and `addInvitedPhone`; add `resolveOwnerByPhone`, `getUser` and `getSetting` to that same `await import("../db/store.js")` destructure.

```typescript
// Declining email is a real choice, not a dead end: it creates a working account so the very next
// message goes to the assistant instead of back into registration. Before this existed, Marlowe
// said "let me know how I can help!" and then deflected every request back to the email question.
describe("handlePendingRegistration — declining email creates a phone-only account", () => {
  it("creates an account with no email, bound to the number", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    const ownerId = resolveOwnerByPhone(phone);
    expect(ownerId).not.toBeNull();
    expect(getUser(ownerId!)?.email).toBeNull();
  });

  it("carries the captured name onto the new account", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Margaret" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    expect(getSetting(resolveOwnerByPhone(phone)!, "user_name")).toBe("Margaret");
  });

  it("marks the registration completed so the next message leaves the registration flow", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    expect(getPendingRegistration(phone)?.step).toBe("completed");
  });

  // The regression that matters most. Before this feature the next message fell through to
  // getRegistrationAssistReply, which nudges the person back toward giving an email.
  it("does not re-ask for an email when they send a real request afterwards", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "Sam" });
    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });
    vi.mocked(sendWhatsAppMessage).mockClear();
    vi.mocked(sendWhatsAppReplyButtons).mockClear();

    await handlePendingRegistration({
      kind: "text",
      from: phone,
      text: "remind me to call mum at 6",
      messageId: "m2",
    });

    expect(sendWhatsAppReplyButtons).not.toHaveBeenCalled();
    expect(sendWhatsAppMessage).not.toHaveBeenCalledWith(phone, expect.stringContaining("email"));
  });

  // A sentence is not a name (plausibleName.ts) — it must not become a permanent display name.
  it("stores no name when what they typed was not a plausible one", async () => {
    const phone = freshPhone();
    addInvitedPhone(phone);
    upsertPendingRegistration(phone, { step: "awaiting_email_confirm", name: "" });

    await handlePendingRegistration({
      kind: "interactive",
      from: phone,
      messageId: "m1",
      buttonId: "email_confirm_no",
    });

    // getSetting returns null (not undefined) for a missing key.
    expect(getSetting(resolveOwnerByPhone(phone)!, "user_name")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/whatsappRegistration.test.ts`
Expected: FAIL — `resolveOwnerByPhone(phone)` is null, because No currently creates nothing.

- [ ] **Step 3: Implement the No branch**

In `server/src/services/whatsappRegistration.ts`, add `findOrCreateUserByPhone` to the existing `../db/store.js` import block. `setSetting` and `completePendingRegistration` are already imported there, and `isPlausibleName` is already imported from `./plausibleName.js` — nothing else is needed.

Replace the `EMAIL_CONFIRM_BUTTON_IDS.no` branch of `handleEmailConfirmTap`:

```typescript
  if (buttonId === EMAIL_CONFIRM_BUTTON_IDS.no) {
    // A real choice now, not a holding pattern: create the account from the phone number alone so
    // the promise in the reply below is one Marlowe can actually keep. Until this existed the step
    // stayed parked here and the next message was deflected back to the email question.
    const user = findOrCreateUserByPhone(row.phone);
    // Same guard and key as sendFirstValueAndBriefingPrompt: a sentence-shaped reply was already
    // rejected at the name step and must not become a permanent display name.
    if (row.name && isPlausibleName(row.name)) {
      setSetting(user.id, "user_name", row.name);
    }
    completePendingRegistration(row.phone);
    await reply(
      row.phone,
      "No problem — you're all set. I can keep track of reminders, to-dos and notes, hold on to any " +
        "photos or documents you send me, and answer whatever you want to ask. Just say the word if you'd " +
        "like to connect an inbox later."
    );
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/whatsappRegistration.test.ts`
Expected: PASS. Every pre-existing test in the file must still pass — particularly the invite-gate and waitlist ones.

- [ ] **Step 5: Remove the superseded placeholder plan**

```bash
git rm feature-to-do/email-less-accounts.md
```

Its content is now covered by the spec. Leaving it would tell the next reader this is unbuilt.

- [ ] **Step 6: Run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/whatsappRegistration.ts server/src/services/whatsappRegistration.test.ts
git commit -m "feat: declining email creates a working phone-only account"
```

---

### Task 5: Tell the model how to offer email to a mailbox-less user

**Files:**
- Modify: `server/src/ai/assistant.ts:1663-1679` (`buildSystemPrompt`'s account list)
- Create: `server/src/ai/systemPromptNoAccounts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (works for any user with zero connected accounts).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `server/src/ai/systemPromptNoAccounts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "./assistant.js";
import { findOrCreateUserByPhone } from "../db/store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44791000${String(counter).padStart(4, "0")}`;
}

describe("buildSystemPrompt with no connected accounts", () => {
  it("tells the model to offer connecting an inbox in chat, not to point at the website", () => {
    const user = findOrCreateUserByPhone(freshPhone());

    const prompt = buildSystemPrompt(user.id);

    expect(prompt).toContain("none connected");
    // The old copy sent WhatsApp-only users to a "Setup page" they have no way to reach.
    expect(prompt).not.toContain("Setup page");
    expect(prompt.toLowerCase()).toContain("offer to connect");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/ai/systemPromptNoAccounts.test.ts`
Expected: FAIL — the prompt still contains "Setup page".

- [ ] **Step 3: Replace the no-accounts copy**

In `server/src/ai/assistant.ts`, change the fallback string in the `accountList` ternary (currently `"(none connected — tell the user to connect an account on the Setup page first)"`):

```typescript
    : "(none connected — this user has no mailbox linked. Anything needing email or calendar is unavailable: say so plainly in one line and offer to connect an inbox, e.g. \"I'd need your email for that — want to connect it?\". Do not mention a Setup page or website; most of these users are on WhatsApp only. Everything else — reminders, to-dos, notes, documents they send, and general questions — works normally, so answer those without mentioning the missing inbox.)"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/ai/systemPromptNoAccounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/assistant.ts server/src/ai/systemPromptNoAccounts.test.ts
git commit -m "feat: offer inbox connection in chat for mailbox-less users"
```

---

### Task 6: Link email onto an existing phone-only account

**Files:**
- Modify: `server/src/routes/authRoutes.ts:319-327` (Google callback), `:448-452` (Microsoft callback)
- Create: `server/src/routes/linkEmailToPhoneAccount.test.ts`

**Interfaces:**
- Consumes: `findOrCreateUserByPhone` (Task 3).
- Produces: no new exports — changes the resolution order inside both callbacks.

- [ ] **Step 1: Write the failing test**

Create `server/src/routes/linkEmailToPhoneAccount.test.ts`. This tests the resolution helper directly rather than driving a full OAuth round trip, which needs live Google credentials:

```typescript
import { describe, it, expect } from "vitest";
import { resolveRegistrationUser } from "./authRoutes.js";
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  getUser,
  resolveOwnerByPhone,
} from "../db/store.js";

let counter = 0;
function freshPhone(): string {
  counter += 1;
  return `44792000${String(counter).padStart(4, "0")}`;
}

describe("resolveRegistrationUser", () => {
  it("fills in the email on the existing phone-only account rather than making a second one", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const email = `linked-${phone}@example.com`;

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.userId).toBe(phoneOnly.id);
    expect(getUser(phoneOnly.id)?.email).toBe(email);
  });

  it("refuses when that email already belongs to a different account, leaving both intact", () => {
    const phone = freshPhone();
    const phoneOnly = findOrCreateUserByPhone(phone);
    const email = `taken-${phone}@example.com`;
    const other = findOrCreateUserByEmail(email);

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("account_exists");
    expect(getUser(phoneOnly.id)?.email).toBeNull();
    expect(resolveOwnerByPhone(phone)).toBe(phoneOnly.id);
    expect(getUser(other.id)?.email).toBe(email);
  });

  it("creates a fresh account when the number is not known yet", () => {
    const phone = freshPhone();
    const email = `brand-new-${phone}@example.com`;

    const result = resolveRegistrationUser(phone, email);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(getUser(result.userId)?.email).toBe(email);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/linkEmailToPhoneAccount.test.ts`
Expected: FAIL — `resolveRegistrationUser` is not exported.

- [ ] **Step 3: Add the shared resolver**

In `server/src/routes/authRoutes.ts`, add near the other module-level helpers (beside `googleMayUseExistingUser`, ~line 158). Add `setUserEmail` to the `../db/store.js` import list, and `resolveOwnerByPhone`:

```typescript
// Both OAuth callbacks need the same three-way decision once a registration completes, so it
// lives here rather than being written twice and drifting.
//
// The phone-first case is the new one: when this number already owns an account (created by
// declining email during onboarding), the address is attached to THAT row. Calling
// findOrCreateUserByEmail instead would quietly create a second account and strand every to-do,
// document and memory the person already has.
export type RegistrationUserResult =
  | { kind: "ok"; userId: number }
  | { kind: "account_exists" };

export function resolveRegistrationUser(phone: string, email: string): RegistrationUserResult {
  const existingByEmail = getUserByEmail(email);
  const phoneOwnerId = resolveOwnerByPhone(phone);

  if (phoneOwnerId !== null) {
    // Already the same account — nothing to attach, just proceed.
    if (existingByEmail && existingByEmail.id === phoneOwnerId) {
      return { kind: "ok", userId: phoneOwnerId };
    }
    // The address belongs to somebody else. Refuse rather than merge: the same call both
    // collision checks in this codebase already make.
    if (existingByEmail) {
      return { kind: "account_exists" };
    }
    setUserEmail(phoneOwnerId, email);
    return { kind: "ok", userId: phoneOwnerId };
  }

  return { kind: "ok", userId: existingByEmail?.id ?? findOrCreateUserByEmail(email).id };
}
```

Add `setUserEmail` to `server/src/db/store.ts`, next to `findOrCreateUserByPhone`:

```typescript
// Attaches an address to a phone-first account once its owner links a mailbox. Throws on a
// collision rather than overwriting, since users.email is UNIQUE and the caller is expected to
// have checked — a thrown error here means a race, not a normal path.
export function setUserEmail(userId: number, email: string): void {
  db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(normalizeEmail(email), userId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/linkEmailToPhoneAccount.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Use the resolver in both callbacks**

In the Google callback, replace lines 319-325 (`const existingUser = getUserByEmail(auth.email);` through `const user = existingUser ?? findOrCreateUserByEmail(auth.email);`) so the `googleMayUseExistingUser` check is kept and the resolver decides identity:

```typescript
      const existingUser = getUserByEmail(auth.email);
      if (existingUser && !googleMayUseExistingUser(existingUser.id, auth.email)) {
        res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
        sendWhatsAppMessage(reg.phone, ACCOUNT_EXISTS_WHATSAPP_TEXT).catch(() => {});
        return;
      }
      const resolution = resolveRegistrationUser(reg.phone, auth.email);
      if (resolution.kind === "account_exists") {
        res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
        sendWhatsAppMessage(reg.phone, ACCOUNT_EXISTS_WHATSAPP_TEXT).catch(() => {});
        return;
      }
      const user = getUser(resolution.userId) as UserRow;
```

Apply the same change in the Microsoft callback at line 450, replacing `const userId = resolved === "none" ? findOrCreateUserByEmail(auth.email).id : resolved;` — keep the existing `resolved === "unverified"` guard above it untouched, and use the resolver only for the `"none"` case:

```typescript
      let userId: number;
      if (resolved === "none") {
        const resolution = resolveRegistrationUser(reg.phone, auth.email);
        if (resolution.kind === "account_exists") {
          res.redirect(`${CLIENT_URL}/connected?error=account_exists`);
          sendWhatsAppMessage(reg.phone, ACCOUNT_EXISTS_WHATSAPP_TEXT).catch(() => {});
          return;
        }
        userId = resolution.userId;
      } else {
        userId = resolved;
      }
```

Import `getUser` and the `UserRow` type in `authRoutes.ts` if not already imported.

- [ ] **Step 6: Run the full suite**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Then: `cd client && npx tsc --noEmit`
Expected: everything passes. `authRoutes.test.ts` covers the existing OAuth paths — those must not regress.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/authRoutes.ts server/src/routes/linkEmailToPhoneAccount.test.ts server/src/db/store.ts
git commit -m "feat: link a mailbox onto an existing phone-only account"
```

---

### Task 7: Rehearse the migration against production data

Not code. The spec makes this a requirement, and it is the mitigation that prevents problems rather than limiting them. Do it before deploying, after Task 6 is merged.

**Files:** none.

- [ ] **Step 1: Take a copy of the production database**

From the Railway volume, download `data/app.db` to a scratch directory. Do not work against the live file.

- [ ] **Step 2: Record what is there now**

```bash
sqlite3 app.db "SELECT count(*) FROM users;"
sqlite3 app.db "SELECT count(*) FROM users WHERE email IS NOT NULL;"
sqlite3 app.db "PRAGMA table_info(users);"
```

Note the row count and confirm `email` shows `notnull=1` (pre-migration).

- [ ] **Step 3: Run the server against the copy**

```bash
cd server && DATA_DIR=/path/to/scratch npm run dev
```

Watch startup for `store: using data directory` and any migration error.

- [ ] **Step 4: Verify the result**

```bash
sqlite3 app.db "PRAGMA table_info(users);"   # email must now show notnull=0
sqlite3 app.db "SELECT count(*) FROM users;" # must equal the Step 2 count exactly
sqlite3 app.db "SELECT count(*) FROM users WHERE email IS NULL;"  # must be 0 — nothing created yet
```

A row-count mismatch means stop and do not deploy.

- [ ] **Step 5: Confirm a real account still works**

Sign in on the portal as the app owner against the scratch database. Confirm the Portal and Settings → Admin both load and the account list shows real email addresses.

---

## Verification

After every task, before opening the PR:

```bash
cd server && npx tsc --noEmit && npx vitest run
cd ../client && npx tsc --noEmit
```

All server tests must pass — the suite was at 975 passing when this plan was written, and this work adds roughly 20 more. Then walk the flow end to end on a real invited test number: message Marlowe, give a name, tap **No**, and confirm the reply, then send "remind me to call mum at 6" and confirm it is treated as a reminder rather than another email prompt.
