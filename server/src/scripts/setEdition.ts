// Moves an existing user between editions. Run from server/:
//   npm run set-edition -- 447911123456 business
import "dotenv/config";
import { resolveOwnerByPhone, setUserEdition, isEditionId, normalizePhone } from "../db/store.js";

const [phone, edition] = process.argv.slice(2);
if (!phone || !isEditionId(edition)) {
  console.error("Usage: npm run set-edition -- 447911123456 general|business");
  process.exit(1);
}
const ownerId = resolveOwnerByPhone(normalizePhone(phone));
if (ownerId === null) {
  console.error(`No account is bound to ${normalizePhone(phone)}.`);
  process.exit(1);
}
setUserEdition(ownerId, edition);
console.log(`User ${ownerId} is now on the ${edition} edition.`);
