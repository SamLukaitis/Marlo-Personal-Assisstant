// Runs fire-and-forget right after a receipt saves (see documents.ts): must never delay the
// "document saved" WhatsApp confirmation the user is waiting on, so any outcome (success or
// failure) arrives as a separate follow-up message instead.
import { listAccounts, listPhoneNumbersForUser, markDocumentXeroForwarded, type DocumentRow } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { getXeroForwardingEmail } from "./xero.js";
import { hubSendMessage } from "./hub.js";
import { sendConnectLink } from "./connectMailboxLink.js";

async function notifyOwner(ownerId: number, text: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  for (const { phone } of listPhoneNumbersForUser(ownerId)) {
    try {
      await sendProactiveMessage(phone, text, "alert");
    } catch (err) {
      console.error("xeroForwarding: failed to notify owner", err);
    }
  }
}

export async function forwardReceiptToXero(
  ownerId: number,
  document: Pick<DocumentRow, "id" | "title" | "mimeType" | "filename" | "xeroForwardedAt">,
  fileBuffer: Buffer
): Promise<void> {
  if (document.xeroForwardedAt) return; // already sent — never re-forward the same document row

  const xeroEmail = getXeroForwardingEmail(ownerId);
  if (!xeroEmail) return; // not connected — nothing to do, silently skip

  const label = document.title ?? "your receipt";

  // Gmail first (it was the only sender before Outlook could send), then Outlook — skipping any
  // mailbox whose Send permission is switched off in Settings.
  const accounts = listAccounts(ownerId).filter((a) => a.canSend);
  const sender = accounts.find((a) => a.provider === "google") ?? accounts[0];
  if (!sender) {
    await notifyOwner(
      ownerId,
      `Saved "${label}" but couldn't forward it to Xero — you don't have a mailbox connected that I can send from.`
    );
    return;
  }

  try {
    await hubSendMessage(ownerId, sender.id, xeroEmail, label, "Forwarded automatically by Marlowe.", {
      filename: document.filename ?? label,
      mimeType: document.mimeType,
      data: fileBuffer,
    });
    markDocumentXeroForwarded(ownerId, document.id, Date.now());
    await notifyOwner(ownerId, `Forwarded "${label}" to Xero (${xeroEmail}).`);
  } catch (err) {
    // An Outlook mailbox connected before sending was switched on — forwarding is a send the
    // user set up, so this is the moment to ask for the one-time reconnect.
    if (err instanceof Error && err.name === "OutlookSendPermissionError") {
      await notifyOwner(
        ownerId,
        `Saved "${label}" but couldn't forward it to Xero — ${sender.email} needs one quick reconnect before I can send from Outlook. Tap the link below and future receipts will forward automatically — this one I'll leave for you to send manually.`
      );
      const phone = listPhoneNumbersForUser(ownerId)[0]?.phone;
      if (phone && isWhatsAppConfigured()) {
        await sendConnectLink(phone, "microsoft", "enable_send").catch((e) =>
          console.error("xeroForwarding: couldn't send the Outlook reconnect link", e)
        );
      }
      return;
    }
    console.error("xeroForwarding: send failed", err);
    await notifyOwner(ownerId, `Saved "${label}" but forwarding it to Xero failed — I'll leave it for you to send manually.`);
  }
}
