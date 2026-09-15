// The app owner's manual "grant this person a hub" tool — this app is invite-only, no
// self-serve signup. Run from server/: npm run invite -- 447911123456
//
// Gated by phone number, not email: send the invited number the WhatsApp number to message, and
// they can complete the whole signup (any mailbox) without you needing to know their email in
// advance — see isPhoneInvited/addInvitedPhone in db/store.ts.
import "dotenv/config";
import { addInvitedPhone, normalizePhone } from "../db/store.js";

const phone = process.argv[2];
if (!phone) {
  console.error("Usage: npm run invite -- 447911123456");
  process.exit(1);
}

addInvitedPhone(phone);
console.log(`Invited: ${normalizePhone(phone)}`);
