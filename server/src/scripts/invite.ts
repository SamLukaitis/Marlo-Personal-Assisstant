// The app owner's manual "grant this person a hub" tool — this app is invite-only, no
// self-serve signup. Run from server/: npm run invite -- someone@gmail.com
import "dotenv/config";
import { addInvitedEmail } from "../db/store.js";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run invite -- someone@example.com");
  process.exit(1);
}

addInvitedEmail(email.trim().toLowerCase());
console.log(`Invited: ${email}`);
