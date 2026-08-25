// Runs fire-and-forget right after a receipt saves (see documents.ts) — mirrors
// reconciliation.ts's checkDocumentAgainstRecentEmails in shape: must never delay the "document
// saved" WhatsApp confirmation the user is waiting on, so any outcome (success or failure)
// arrives as a separate follow-up message instead.
import { listAccounts, listPhoneNumbersForUser, type DocumentRow } from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";
import { getXeroForwardingEmail } from "./xero.js";
import { hubSendMessage } from "./hub.js";

async function notifyOwner(ownerId: number, text: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  for (const { phone } of listPhoneNumbersForUser(ownerId)) {
    try {
      await sendWhatsAppMessage(phone, text);
    } catch (err) {
      console.error("xeroForwarding: failed to notify owner", err);
    }
  }
}

export async function forwardReceiptToXero(
  ownerId: number,
  document: Pick<DocumentRow, "title" | "mimeType" | "filename">,
  fileBuffer: Buffer
): Promise<void> {
  const xeroEmail = getXeroForwardingEmail(ownerId);
  if (!xeroEmail) return; // not connected — nothing to do, silently skip

  const label = document.title ?? "your receipt";

  // Sending needs a Gmail account to send *from* (see hubSendMessage) — Outlook can't send yet
  // (feature-to-do/xero-receipt-forwarding.md step 2), so this is a real, expected gap today,
  // not an error condition to alarm the user about.
  const googleAccount = listAccounts(ownerId, "google")[0];
  if (!googleAccount) {
    await notifyOwner(
      ownerId,
      `Saved "${label}" but couldn't forward it to Xero — you don't have a Gmail account connected to send from yet.`
    );
    return;
  }

  try {
    await hubSendMessage(ownerId, googleAccount.id, xeroEmail, label, "Forwarded automatically by Marlowe.", {
      filename: document.filename ?? label,
      mimeType: document.mimeType,
      data: fileBuffer,
    });
    await notifyOwner(ownerId, `Forwarded "${label}" to Xero (${xeroEmail}).`);
  } catch (err) {
    console.error("xeroForwarding: send failed", err);
    await notifyOwner(ownerId, `Saved "${label}" but forwarding it to Xero failed — I'll leave it for you to send manually.`);
  }
}
