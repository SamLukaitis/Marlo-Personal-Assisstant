// Repairs one account split by the pre-fix replay-onboarding bug: replay DELETED the
// user_phone_numbers row, so the "No" tap at the email question minted a second, phone-only
// account (email NULL) that kept the number while the original kept the address. Neither half can
// reach the other afterwards — Settings refuses the number ("already registered to another
// account") and connecting the mailbox refuses the address ("already belongs to a Marlowe
// account"). Nothing in the app heals that, hence this.
//
//   node scripts/heal-split-account.cjs --phone 447845500432 --into 12           # dry run
//   node scripts/heal-split-account.cjs --phone 447845500432 --into 12 --apply   # do it
//
// Moves the phone to the account you name and clears the per-number state that would otherwise be
// inherited from the shell. Deletes NO account and NO data: the phone-only shell is left behind
// with whatever it accumulated, unreachable (no phone, no address to sign in with) and recoverable
// if you ever want what's in it. Wiping it is a separate, deliberate decision.
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}
const rawPhone = arg("phone");
const intoRaw = arg("into");
const apply = process.argv.includes("--apply");
// Also delete any number already on the target that can never match an inbound WhatsApp sender —
// i.e. one stored in national format, with a leading 0. Those are what the Settings route used to
// accept (it now rejects them; see services/phoneFormat.ts), and they are the reason the account
// got split in the first place: the dead row looked like a working binding while every real message
// from that number fell through to registration. Opt-in, because it is the one thing here that
// deletes a row.
const dropUnmatchable = process.argv.includes("--drop-unmatchable");

if (!rawPhone || !intoRaw) {
  console.error("usage: node scripts/heal-split-account.cjs --phone <number> --into <userId> [--apply]");
  process.exit(1);
}
// Same normalization store.ts applies, so a number typed with spaces or a + matches the stored row.
const phone = rawPhone.replace(/[^0-9]/g, "");
const into = Number(intoRaw);
if (!Number.isInteger(into) || into <= 0) {
  console.error(`--into must be a user id; got ${intoRaw}`);
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "app.db");
if (!fs.existsSync(dbPath)) {
  console.error(`no app.db at ${dbPath} — set DATA_DIR to the volume mount path`);
  process.exit(1);
}
const db = new Database(dbPath);
// replay_parked_phones only exists once a server carrying the park-table change has booted against
// this DB. Guarded so the script also works on a DB that predates it rather than throwing.
const hasParkTable =
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'replay_parked_phones'`).get() !== undefined;

const target = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(into);
if (!target) {
  console.error(`no user ${into} — run scripts/diagnose-accounts.cjs to see the real ids`);
  process.exit(1);
}
const row = db
  .prepare(`SELECT id, user_id AS userId FROM user_phone_numbers WHERE phone = ?`)
  .get(phone);
if (!row) {
  console.error(`${phone} is not bound to any account — add it from Settings instead, nothing to move`);
  process.exit(1);
}
if (row.userId === into) {
  console.log(`${phone} already belongs to user ${into} (${target.email ?? "NULL"}) — nothing to do`);
  process.exit(0);
}
// Refuse to strand the target's own binding: phone is UNIQUE, so it can hold at most one row for
// this number, but it may hold OTHER numbers, which this leaves alone.
const donor = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(row.userId);
if (donor && donor.email !== null) {
  console.error(
    `user ${donor.id} holds ${phone} and has its own address (${donor.email}) — that is not the ` +
      `phone-only shell this bug produces, so moving the number would take it from a real account. ` +
      `Check scripts/diagnose-accounts.cjs and move it by hand if you are sure.`
  );
  process.exit(1);
}

const summaries = db.prepare(`SELECT COUNT(*) AS n FROM whatsapp_conversation_summaries WHERE phone = ?`).get(phone).n;
const pending = db.prepare(`SELECT step FROM pending_whatsapp_registrations WHERE phone = ?`).get(phone);
const leftBehind = db
  .prepare(`SELECT COUNT(*) AS n FROM whatsapp_messages WHERE owner_id = ?`)
  .get(row.userId).n;

console.log(`${apply ? "APPLYING" : "DRY RUN"} — ${dbPath}\n`);
console.log(`move  ${phone}`);
console.log(`from  user ${row.userId} (email NULL — the phone-only shell)`);
console.log(`into  user ${into} (${target.email ?? "NULL"})`);
console.log(`\nalso clears, so the number arrives clean rather than carrying the shell's state:`);
console.log(`  whatsapp_conversation_summaries for ${phone}: ${summaries} row(s)`);
console.log(`  pending_whatsapp_registrations for ${phone}: ${pending ? `step=${pending.step}` : "none"}`);
console.log(
  `  replay_parked_phones for ${phone}: ${hasParkTable ? "cleared if present" : "table not in this DB yet"}`
);
// Same rule as services/phoneFormat.ts's leading-0 check, restated here because this is a plain
// .cjs ops script and cannot import the TypeScript module. Keep the two in step.
const unmatchable = db
  .prepare(`SELECT id, phone FROM user_phone_numbers WHERE user_id = ? AND phone LIKE '0%'`)
  .all(into);
if (unmatchable.length > 0) {
  console.log(`\nuser ${into} also holds ${unmatchable.length} number(s) that can never match an inbound sender:`);
  for (const u of unmatchable) {
    console.log(`  ${u.phone}  (national format — WhatsApp delivers 44…, never 0…)`);
  }
  console.log(dropUnmatchable ? "  -> will be DELETED (--drop-unmatchable)" : "  -> left alone; pass --drop-unmatchable to delete");
}

console.log(`\nleft untouched on user ${row.userId}: ${leftBehind} whatsapp message(s) and everything else it holds.`);

if (!apply) {
  console.log(`\nre-run with --apply to make these changes.`);
  process.exit(0);
}

db.transaction(() => {
  db.prepare(`UPDATE user_phone_numbers SET user_id = ? WHERE id = ?`).run(into, row.id);
  // Keyed by phone, not owner — without this the target inherits the rolling conversation summary
  // the shell built up, and it goes into the assistant's system prompt as if it were the target's
  // own history.
  db.prepare(`DELETE FROM whatsapp_conversation_summaries WHERE phone = ?`).run(phone);
  // A leftover "completed" registration row for this number is inert once the number resolves, but
  // a half-finished one would resume mid-flow if the number is ever unbound again.
  db.prepare(`DELETE FROM pending_whatsapp_registrations WHERE phone = ?`).run(phone);
  if (hasParkTable) db.prepare(`DELETE FROM replay_parked_phones WHERE phone = ?`).run(phone);
  if (dropUnmatchable) {
    for (const u of unmatchable) {
      db.prepare(`DELETE FROM user_phone_numbers WHERE id = ?`).run(u.id);
    }
  }
})();

const now = db.prepare(`SELECT user_id AS userId FROM user_phone_numbers WHERE phone = ?`).get(phone);
console.log(`\ndone — ${phone} now resolves to user ${now.userId}.`);
console.log(`sign in as ${target.email ?? `user ${into}`} and connect the mailbox from Settings.`);
