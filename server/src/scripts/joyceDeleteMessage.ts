// For a developer, when a family asks to delete something older than 24 hours (Joyce only lets
// members delete their own messages within 24 hours — see joyce/deleting.ts). Run it where the
// family data lives (on Railway: in the service's shell), with JOYCE_MASTER_KEY set. Where dev
// tools aren't installed, run the compiled copy instead: node dist/scripts/joyceDeleteMessage.js
//
//   npm run joyce:delete -- <phone of a family member> "<words from the message>"
//       Lists matching messages in that person's family, newest first, with their ids.
//   npm run joyce:delete -- <phone> --id <message id>
//       Shows exactly what deleting that message would remove. Changes nothing.
//   npm run joyce:delete -- <phone> --id <message id> --confirm
//       Deletes it and everything made from it.
//
// The family is found from a member's phone number, the same way Joyce finds it; there's no way
// to name a family directly. Ask the person who wants it gone for their number.
import "dotenv/config";
import { normalizeJoycePhone } from "../joyce/familyKey.js";
import { openFamilySessionForPhone } from "../joyce/familyDb.js";
import { getMessage, searchFamilyChat } from "../joyce/store.js";
import { collectDerived, deleteItems, describeItems } from "../joyce/provenance.js";

function main(): void {
  const args = process.argv.slice(2);
  const phone = args[0] ? normalizeJoycePhone(args[0]) : "";
  if (!phone) throw new Error('Usage: npm run joyce:delete -- <phone> "<words>" | --id <n> [--confirm]');

  // Opening a session records this number as "seen", like any message would; harmless.
  const session = openFamilySessionForPhone(phone);
  if (!session) throw new Error("That number isn't in a Joyce family.");

  const idFlag = args.indexOf("--id");
  if (idFlag === -1) {
    const query = args.slice(1).join(" ");
    const hits = searchFamilyChat(session, query, 20);
    if (hits.length === 0) return console.log("No messages matched.");
    for (const h of hits) {
      console.log(`id ${h.id} — ${h.senderName ?? "someone"}, ${new Date(h.createdAt).toISOString()}: ${h.body}`);
    }
    return;
  }

  const id = Number(args[idFlag + 1]);
  const message = getMessage(session, id);
  if (!message || message.role !== "user") throw new Error(`No member message with id ${id} in this family.`);
  const items = collectDerived(session, { type: "message", id });
  console.log(`Message ${id}, sent ${new Date(message.createdAt).toISOString()}: ${message.body}\n`);
  console.log("Deleting it removes:");
  for (const line of describeItems(session, items)) console.log(`  - ${line}`);
  if (!args.includes("--confirm")) return console.log("\nNothing changed. Add --confirm to delete.");
  const removed = deleteItems(session, items);
  console.log(`\nDeleted ${removed} item${removed === 1 ? "" : "s"}.`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
