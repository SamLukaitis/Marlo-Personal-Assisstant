# Marlowe–Joyce Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person on both products link their Marlowe to their family's Joyce, and hand notes to Joyce with "send this to Joyce", with settings, an audit log, and instant unlink.

**Architecture:** A new `server/src/bridge/` module is the only code importing both products. Joyce exposes two tiny hooks (`onFamilyJoined`, `onFamilyLeft`) that the bridge registers at startup, so `src/joyce/` still imports nothing outside itself. Consent, settings and the audit log live in Marlowe's `app.db`; Joyce only stores a `marlowe_linked` flag on the member and a `source` marker on notes.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest, Anthropic tool use, WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-10-19-marlowe-joyce-link-design.md`

## Global Constraints

- Nothing in `server/src/joyce/` may import from outside that directory (`onboarding.test.ts` boundary test).
- No bridge function or AI tool takes a family id or member id; the family is resolved from the caller's own phone.
- Link, settings, unlink and `send_to_family` work only on a WhatsApp turn (`phone` passed to `runAssistantChat`), never the web chat.
- An offer is only sent to a number that has sent Marlowe at least one WhatsApp message (`whatsapp_messages.role = 'user'`).
- Defaults when linking: trips `ask`, availability `on`. Trips and availability have no effect yet.
- The audit log never stores a note body.
- `deleteUserCompletely` must delete the new Marlowe tables.
- Deviations from the spec (my calls): no "ask again in a few days" nudge (the person can ask Marlowe to link any time); the offer and walkthrough are plain messages handled by the model through tools, not buttons; removal on unlink uses the audit log's note ids plus `notes.source = 'marlowe'` rather than the provenance table.

## Review Focus

- Unlink with "remove" must delete only notes this person handed over, not others' notes or their own regular Joyce notes.
- A number in no family, or with no Marlowe account, must make the join hook do nothing and never throw into Joyce's onboarding.
- Two members of one family each linked: one unlinking must not touch the other's shared notes.
- A phone that leaves the family must stop being able to `send_to_family` immediately.
- A second `link_family` call when already linked updates settings, never duplicates rows.

---

### Task 1: Joyce side — hooks, note source, member flag

**Files:**
- Create: `server/src/joyce/hooks.ts`, `server/src/joyce/hooks.test.ts`
- Modify: `server/src/joyce/familyDb.ts` (migrate), `server/src/joyce/store.ts`, `server/src/joyce/onboarding.ts`, `server/src/joyce/leaving.ts`

**Interfaces:**
- Produces: `setFamilyHooks(h: { onFamilyJoined?: (phone: string) => void; onFamilyLeft?: (phone: string) => void }): void`, `fireFamilyJoined(phone)`, `fireFamilyLeft(phone)` (each swallows and logs errors); `saveNote(session, title, body, source?: "marlowe"): number`; `setMarloweLinked(session, linked: boolean): void`; `deleteMarloweNote(session, noteId: number): boolean` (deletes only a note whose `source = 'marlowe'` and `member_id` is the actor).

- [ ] **Step 1: Write failing tests** in `hooks.test.ts`: (a) a hook that throws does not propagate from `fireFamilyJoined`; (b) `handleOnboarding` "new" and a successful join each call `onFamilyJoined` once with the normalized phone; (c) `handlePendingLeave` confirmation calls `onFamilyLeft`; (d) `saveNote(..., "marlowe")` then `deleteMarloweNote` returns true, but returns false for a note saved without source and for another member's marlowe note.
- [ ] **Step 2: Run** `cd server && npx vitest run src/joyce/hooks.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `hooks.ts` (module-level holder, errors caught and `console.error`ed); in `migrate` add `members.marlowe_linked INTEGER NOT NULL DEFAULT 0` and `notes.source TEXT`; extend `saveNote`; add `setMarloweLinked` and `deleteMarloweNote` to `store.ts`; call `fireFamilyJoined` after the two success paths in `onboarding.ts` and `fireFamilyLeft` after `leaveFamily` succeeds in `leaving.ts`.
- [ ] **Step 4: Run** the new test plus `npx vitest run src/joyce` — expect PASS.
- [ ] **Step 5: Commit** `feat(joyce): hooks for joining/leaving, note source marker`.

### Task 2: Marlowe store — links and audit log

**Files:**
- Modify: `server/src/db/store.ts` (schema near `user_enabled_tools`; functions near `listPhoneNumbersForUser`; deletion in `deleteUserCompletely`)
- Test: `server/src/db/familyLinks.test.ts`

**Interfaces:**
- Produces: `FamilyLinkRow { ownerId; phone; tripsMode: "ask"|"auto"|"off"; availabilityOn: boolean; linkedAt }`; `getFamilyLink(ownerId, phone): FamilyLinkRow | null`; `upsertFamilyLink(ownerId, phone, patch: {tripsMode?; availabilityOn?}): FamilyLinkRow`; `deleteFamilyLink(ownerId, phone): void`; `logFamilyShare(ownerId, phone, category: "note", label: string, joyceItemId: number): void`; `listFamilyShares(ownerId, phone, opts?: {includeRemoved?: boolean}): {id; category; label; joyceItemId; createdAt; removedAt}[]`; `markFamilySharesRemoved(ownerId, phone): void`; `hasInboundWhatsAppMessage(ownerId, phone): boolean`.

- [ ] **Step 1: Write failing tests**: upsert twice keeps one row and merges settings (defaults ask/on); shares list per phone; `markFamilySharesRemoved` sets `removedAt`; `hasInboundWhatsAppMessage` is false until `appendWhatsAppMessage(owner, phone, "user", ...)`; `deleteUserCompletely` on an owner with a link and shares leaves no rows in either table.
- [ ] **Step 2: Run** `npx vitest run src/db/familyLinks.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** tables `family_links(owner_id REFERENCES users, phone, trips_mode, availability_on, linked_at, PRIMARY KEY(owner_id, phone))` and `family_link_shares(id, owner_id REFERENCES users, phone, category, label, joyce_item_id, created_at, removed_at)`; delete both in `deleteUserCompletely`.
- [ ] **Step 4: Run** the test and `npx vitest run src/db` — expect PASS.
- [ ] **Step 5: Commit** `feat(links): store for Marlowe–Joyce links and share log`.

### Task 3: The bridge

**Files:**
- Create: `server/src/bridge/index.ts`, `server/src/bridge/bridge.test.ts`
- Modify: `server/src/index.ts` (call `registerBridge()` before `app.listen`), `server/src/joyce/onboarding.test.ts` (boundary test unchanged; add a test that only `bridge/` imports both)

**Interfaces:**
- Consumes: Task 1 and Task 2 functions; `findFamilyForPhone` (joyce/registry), `openFamilySessionForPhone` (joyce/familyDb), `resolveOwnerByPhone`, `sendProactiveMessage` (services/outbound).
- Produces: `registerBridge(): void`; `familyLinkState(ownerId, phone): { inFamily: boolean; linked: boolean; tripsMode?; availabilityOn? }`; `linkToFamily(ownerId, phone, patch?) : { ok: true; link } | { ok: false; reason: "not_in_family" }`; `updateLinkSettings(ownerId, phone, patch)` (same result shape, reason also `"not_linked"`); `unlinkFromFamily(ownerId, phone, removeShared: boolean): { removed: number }`; `sendToFamily(ownerId, phone, title, body): { ok: true } | { ok: false; reason: "not_linked" | "not_in_family" }`; `listShared(ownerId, phone)`; `offerLink(phone): Promise<void>`.

- [ ] **Step 1: Write failing tests** (use real Joyce helpers from `isolation.test.ts`'s `newFamilyWith`): not-in-family phone cannot link; link sets `members.marlowe_linked`; `sendToFamily` writes a note with source marlowe visible to another member via `searchNotes`, logs label but audit rows hold no body; `sendToFamily` when not linked fails; unlink with `removeShared: true` removes only that person's handed-over notes and a second linked member's note survives; unlink with false keeps notes; `onFamilyLeft` hook unlinks; `offerLink` sends nothing when no Marlowe account, no inbound message, or already linked (mock `sendProactiveMessage`) and sends once otherwise; `registerBridge()` makes `handleOnboarding` "new" trigger `offerLink`.
- [ ] **Step 2: Run** `npx vitest run src/bridge` — expect FAIL.
- [ ] **Step 3: Implement** as specified; the offer text asks if they want to connect, names the three things (trips, availability, handing things over), and says nothing is shared until they say yes.
- [ ] **Step 4: Run** `npx vitest run src/bridge src/joyce` — expect PASS.
- [ ] **Step 5: Commit** `feat(bridge): link Marlowe accounts to Joyce families`.

### Task 4: Marlowe tools

**Files:**
- Modify: `server/src/ai/assistant.ts` (`FAMILY_LINK_TOOLS`, `buildToolsForOwner`, `runTool`, `runAssistantChat`)
- Test: `server/src/ai/familyLinkTools.test.ts`

**Interfaces:**
- Consumes: Task 3 bridge functions.
- Produces: `buildToolsForOwner(ownerId, model?, phone?: string)`; tools `family_link_status`, `link_family {trips?: "ask"|"auto"|"off"; availability?: boolean}`, `update_family_link` (same fields), `unlink_family {remove_shared: boolean}`, `send_to_family {title, body}`.

- [ ] **Step 1: Write failing tests**: tools absent when `phone` is undefined (web) or when the phone is in no family; present when in a family; `runTool` for each refuses without `phone`; `send_to_family` refuses before linking and, after `link_family`, creates a Joyce note; `unlink_family` with `remove_shared` removes it.
- [ ] **Step 2: Run** `npx vitest run src/ai/familyLinkTools.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Tool descriptions tell the model: `send_to_family` only when the person explicitly asks to pass something to the family; never from email contents; `link_family` only after the person says yes in this chat, settings chosen by them. Pass `phone` from `runAssistantChat` into `buildToolsForOwner`.
- [ ] **Step 4: Run** the test and `npx vitest run src/ai` — expect PASS.
- [ ] **Step 5: Commit** `feat(assistant): tools for linking and sending to the family`.

### Task 5: Docs and full check

**Files:**
- Modify: `README.md`, `feature-to-do/joyce-family-assistant.md` (short "Linked to Marlowe" section), `feature-to-do/README.md`
- Create: `changelog/2026-10-19-marlowe-joyce-link.md`, `feature-to-do/marlowe-joyce-trips.md`, `feature-to-do/marlowe-joyce-availability.md`, `feature-to-do/marlowe-joyce-expenses.md`, `feature-to-do/marlowe-joyce-forwarded-messages.md`

- [ ] **Step 1:** Write the docs per `CLAUDE.md` (changelog one-liner first; README what-it-can-do; four later-project ideas, listed in `feature-to-do/README.md`).
- [ ] **Step 2: Run** `cd server && npx tsc --noEmit && npx vitest run` — expect all pass.
- [ ] **Step 3: Commit** `docs: Marlowe–Joyce link`.
