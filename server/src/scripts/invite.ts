// The app owner's manual "grant this person a hub" tool — this app is invite-only, no
// self-serve signup. Run from server/: npm run invite -- 447911123456 [--edition business]
//
// Gated by phone number, not email: send the invited number the WhatsApp number to message, and
// they can complete the whole signup (any mailbox) without you needing to know their email in
// advance — see isPhoneInvited/addInvitedPhone in db/store.ts. --edition puts them on that
// product from their first message (docs/superpowers/specs/2026-10-16-business-edition-design.md).
import "dotenv/config";
import { addInvitedPhone, normalizePhone, isEditionId } from "../db/store.js";

const phone = process.argv[2];
const flag = process.argv.indexOf("--edition");
const edition = flag > -1 ? process.argv[flag + 1] : undefined;
if (!phone || phone.startsWith("--") || (edition !== undefined && !isEditionId(edition))) {
  console.error("Usage: npm run invite -- 447911123456 [--edition general|business]");
  process.exit(1);
}

addInvitedPhone(phone, edition);
console.log(`Invited: ${normalizePhone(phone)}${edition ? ` (${edition} edition)` : ""}`);
