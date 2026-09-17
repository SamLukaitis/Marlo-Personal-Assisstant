// Rehearses the users.email-nullable migration against a COPY of a real database, so the one
// change in this codebase that can destroy data is proven on real rows before it runs in
// production. Required by docs/superpowers/specs/2026-09-17-phone-first-accounts-design.md.
//
// Usage:  npx tsx src/scripts/rehearseMigration.ts <dir containing app.db>
//
// Point it at a SCRATCH DIRECTORY holding a copy — never the live file. It refuses to run against
// server/data to make that mistake harder. It imports store.ts, which is what a real boot does, so
// every migration runs in the real order rather than this one in isolation.
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npx tsx src/scripts/rehearseMigration.ts <dir containing app.db>");
  process.exit(1);
}

const dataDir = path.resolve(dir);
const dbPath = path.join(dataDir, "app.db");

if (!fs.existsSync(dbPath)) {
  console.error(`no app.db in ${dataDir}`);
  process.exit(1);
}

// The whole point is to not touch the real thing.
const liveDir = path.resolve(process.cwd(), "data");
if (dataDir === liveDir) {
  console.error("refusing to run against server/data — copy app.db to a scratch directory first");
  process.exit(1);
}

interface ColumnInfo {
  name: string;
  notnull: number;
}

function inspect(): { users: number; emails: number; nullEmails: number; notnull: number | null } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const users = (db.prepare(`SELECT count(*) AS n FROM users`).get() as { n: number }).n;
    const emails = (db.prepare(`SELECT count(*) AS n FROM users WHERE email IS NOT NULL`).get() as { n: number }).n;
    const nullEmails = users - emails;
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as ColumnInfo[];
    const notnull = cols.find((c) => c.name === "email")?.notnull ?? null;
    return { users, emails, nullEmails, notnull };
  } finally {
    db.close();
  }
}

const before = inspect();
console.log(`\n=== BEFORE ===`);
console.log(`  database:        ${dbPath}`);
console.log(`  users:           ${before.users}`);
console.log(`  with an email:   ${before.emails}`);
console.log(`  with NULL email: ${before.nullEmails}`);
console.log(`  email notnull:   ${before.notnull} ${before.notnull === 1 ? "(pre-migration, as expected)" : "(already migrated)"}`);

// store.ts reads DATA_DIR at module load, so this has to be set before the import. Importing it
// is exactly what a real boot does — every migration runs, in order, against this copy.
process.env.DATA_DIR = dataDir;

console.log(`\n=== RUNNING MIGRATIONS (importing store.ts, as a real boot does) ===`);
let bootError: unknown = null;
try {
  await import("../db/store.js");
} catch (err) {
  bootError = err;
}

if (bootError) {
  console.error(`\n  ✗ BOOT FAILED — this is what would crash-loop in production:\n`);
  console.error(bootError);
}

const after = inspect();
console.log(`\n=== AFTER ===`);
console.log(`  users:           ${after.users}`);
console.log(`  with an email:   ${after.emails}`);
console.log(`  with NULL email: ${after.nullEmails}`);
console.log(`  email notnull:   ${after.notnull}`);

const backups = fs.readdirSync(dataDir).filter((f) => f.startsWith("app.db.bak"));
console.log(`  backups written: ${backups.length ? backups.join(", ") : "none"}`);

console.log(`\n=== VERDICT ===`);
const checks: [string, boolean, string][] = [
  ["boot completed without throwing", bootError === null, "the server would crash-loop on this database"],
  ["row count unchanged", after.users === before.users, `${before.users} → ${after.users} — STOP, DO NOT DEPLOY`],
  ["every existing email preserved", after.emails === before.emails, `${before.emails} → ${after.emails} — STOP, DO NOT DEPLOY`],
  ["email column is now nullable", after.notnull === 0, "the migration did not take effect"],
  ["no rows gained a NULL email", after.nullEmails === before.nullEmails, "the migration should not create accounts"],
  ["exactly one backup taken", backups.length === 1, `${backups.length} — a crash loop would keep adding these`],
];

let ok = true;
for (const [label, passed, consequence] of checks) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${passed ? "" : ` — ${consequence}`}`);
  if (!passed) ok = false;
}

console.log(
  ok
    ? `\n  Rehearsal clean. Safe to deploy this migration.\n`
    : `\n  Rehearsal FAILED. Do not deploy — the production database would hit the same thing.\n`
);
process.exit(ok ? 0 : 1);
