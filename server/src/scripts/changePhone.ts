// Moves an account to a new WhatsApp number, keeping all its data. Run from server/, on the
// machine that holds the real database (production: inside the Railway container):
//   npm run change-phone -- 447845500432 51991745531            # dry run: shows what would change
//   npm run change-phone -- 447845500432 51991745531 --apply    # does it
// See services/phoneChange.ts for what moves and what doesn't. Take a copy of data/app.db first.
import "dotenv/config";
import { changePhone } from "../services/phoneChange.js";

const [oldPhone, newPhone] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!oldPhone || !newPhone) {
  console.error("Usage: npm run change-phone -- <old number> <new number> [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");

const plan = changePhone(oldPhone, newPhone, { apply });
console.log(`${plan.oldPhone} -> ${plan.newPhone}${plan.ownerId ? ` (account ${plan.ownerId})` : ""}`);
for (const w of plan.warnings) console.log(`WARNING: ${w}`);
if (!plan.ok) {
  for (const p of plan.problems) console.error(`STOPPED: ${p}`);
  process.exit(1);
}
for (const [table, n] of Object.entries(plan.counts)) console.log(`  ${table}: ${n} row(s)`);
console.log(plan.applied ? "Done. Nothing else to do." : "Dry run only. Re-run with --apply to make the change.");
