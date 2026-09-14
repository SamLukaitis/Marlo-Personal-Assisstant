// Resolves a WhatsApp swipe-to-reply (Meta's `context.id`) back to what was actually said/sent —
// no matter how long ago, since whatsapp_message_wamids/documents.wamid are never pruned (see
// db/store.ts). Shared by chatDispatch.ts (text) and whatsappRoutes.ts (media), both of which need
// the exact same resolve-then-inject shape used elsewhere for same-turn context (handleLink's/
// handleMedia's docContext).
//
// A document match is checked before a plain message match: the message row for a photo/file the
// user sent only ever holds the short "[Sent a file]" placeholder (see chatDispatch.ts/
// whatsappRoutes.ts's handleMedia), so resolving to the saved document's real extracted_text is
// what actually answers "what's this" — falling back to the placeholder would just reproduce the
// bug this feature exists to fix.
import { getDocumentByWamid, getWhatsAppMessageByWamid } from "../db/store.js";

export function resolveQuotedMessageContext(
  ownerId: number,
  quotedMessageId: string | undefined,
  forwarded: boolean | undefined
): string | null {
  const parts: string[] = [];

  if (quotedMessageId) {
    const doc = getDocumentByWamid(ownerId, quotedMessageId);
    if (doc) {
      const label = doc.title ?? doc.filename ?? "a file";
      parts.push(
        `[The user swipe-replied to an earlier photo/document they sent ("${label}"). Its extracted ` +
          `content:\n${doc.extractedText}]`
      );
    } else {
      const msg = getWhatsAppMessageByWamid(ownerId, quotedMessageId);
      if (msg) {
        parts.push(`[The user swipe-replied to an earlier message: "${msg.content}"]`);
      } else {
        // Predates this feature, or was never recorded for some other reason — say so plainly
        // rather than guessing at what it might have been from surrounding context.
        parts.push(
          "[The user swipe-replied to an earlier message, but you can't see what it was — it's " +
            "from before this could be tracked, or wasn't recorded. Don't guess at its content; " +
            "ask them to resend or describe it if you need to know.]"
        );
      }
    }
  }

  if (forwarded) {
    parts.push("[This message was forwarded from another chat.]");
  }

  return parts.length ? parts.join(" ") : null;
}
