// READ-ONLY diagnosis of the "one person, two accounts" state this branch's phone-first work can
// leave behind (see docs/superpowers/specs/2026-09-17-phone-first-accounts-PR.md). Writes nothing.
//
//   node scripts/diagnose-accounts.cjs            # from the server/ directory (or the container's WORKDIR)
//
// Prints every users row with the phones bound to it (marking any parked by replay-onboarding),
// its connected mailboxes, and how many rows of real data it holds — which is what tells you which
// of a split pair is the account worth keeping.
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "app.db");
if (!fs.existsSync(dbPath)) {
  console.error(`no app.db at ${dbPath} — set DATA_DIR to the volume mount path`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true });

const phoneCols = db.prepare(`PRAGMA table_info(user_phone_numbers)`).all().map((c) => c.name);
const hasPark = phoneCols.includes("unbound_for_replay_at");
console.log(`db: ${dbPath}`);
console.log(`unbound_for_replay_at column present: ${hasPark}\n`);

// Same idea as findRemainingOwnerReferences: ask the live schema which columns point at
// users(id), so a newly-added owner-scoped table shows up here without editing this script.
const ownerRefs = [];
for (const { name: table } of db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all()) {
  if (table === "users") continue;
  for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
    if (fk.table === "users" && fk.from) ownerRefs.push({ table, column: fk.from });
  }
}

const users = db.prepare(`SELECT id, email, created_at FROM users ORDER BY id`).all();
for (const u of users) {
  const phones = db
    .prepare(
      `SELECT phone${hasPark ? ", unbound_for_replay_at AS parked" : ", NULL AS parked"} FROM user_phone_numbers WHERE user_id = ?`
    )
    .all(u.id);
  const mailboxes = db.prepare(`SELECT provider, email FROM accounts WHERE owner_id = ?`).all(u.id);
  const data = ownerRefs
    .map(({ table, column }) => {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(u.id).n;
      return n > 0 ? `${table}=${n}` : null;
    })
    .filter(Boolean);
  console.log(`user ${u.id}  email=${u.email === null ? "NULL" : u.email}  created=${new Date(u.created_at).toISOString()}`);
  console.log(
    `  phones:    ${phones.length === 0 ? "(none)" : phones.map((p) => `${p.phone}${p.parked ? " [PARKED by replay]" : ""}`).join(", ")}`
  );
  console.log(`  mailboxes: ${mailboxes.length === 0 ? "(none)" : mailboxes.map((a) => `${a.provider}:${a.email}`).join(", ")}`);
  // Which numbers this account has actually held a conversation with, which is the only record of
  // a binding that has since been deleted — an account with messages but no phone above was
  // talking to a number it no longer owns, and this says which. Marked where that number now
  // belongs to somebody else, i.e. the account is split.
  const talkedTo = db
    .prepare(`SELECT phone, COUNT(*) AS n FROM whatsapp_messages WHERE owner_id = ? GROUP BY phone ORDER BY n DESC`)
    .all(u.id);
  console.log(
    `  talked to: ${
      talkedTo.length === 0
        ? "(no whatsapp messages)"
        : talkedTo
            .map((t) => {
              const boundTo = db
                .prepare(`SELECT user_id AS userId FROM user_phone_numbers WHERE phone = ?`)
                .get(t.phone);
              const where =
                boundTo === undefined
                  ? "unbound"
                  : boundTo.userId === u.id
                    ? "bound here"
                    : `NOW BOUND TO user ${boundTo.userId}`;
              return `${t.phone} (${t.n} msg, ${where})`;
            })
            .join(", ")
    }`
  );
  console.log(`  data:      ${data.length === 0 ? "(none)" : data.join(" ")}\n`);
}

const pending = db
  .prepare(`SELECT phone, step, name, typed_email, provider, updated_at FROM pending_whatsapp_registrations`)
  .all();
console.log(`pending_whatsapp_registrations: ${pending.length === 0 ? "(none)" : ""}`);
for (const p of pending) {
  console.log(
    `  ${p.phone}  step=${p.step}  name=${p.name || "-"}  typedEmail=${p.typed_email || "-"}  provider=${p.provider || "-"}  updated=${new Date(p.updated_at).toISOString()}`
  );
}
