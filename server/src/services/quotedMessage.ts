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
//
// A message that went out as several WhatsApp messages resolves to the one part that was swiped,
// with the full message as context. Resolving to the whole message let the model answer about a
// different part of it (asked "what's this" about an anime list, it explained an email alert).
import { getDocumentByWamid, getWhatsAppMessageByWamid, getRecentWhatsAppMessagesForOwner } from "../db/store.js";

// How many of Marlowe's recent messages to offer when a swipe can't be resolved, and how much of
// each — enough to recognise which one the user meant without bloating the turn.
const RECENT_CANDIDATES = 5;
const MAX_CANDIDATE_CHARS = 400;

export function resolveQuotedMessageContext(
  ownerId: number,
  quotedMessageId: string | undefined,
  forwarded: boolean | undefined,
  phone?: string
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
      if (msg?.role === "user") {
        parts.push(`[The user swipe-replied to an earlier message of their own: "${msg.content}"]`);
      } else if (msg?.partText) {
        parts.push(
          `[The user swipe-replied to this part of an earlier message of yours: "${msg.partText}". ` +
            `Their message is about that part, not the rest. The full message it was part of, for ` +
            `context: "${msg.content}"]`
        );
      } else if (msg) {
        parts.push(`[The user swipe-replied to an earlier message of yours: "${msg.content}"]`);
      } else {
        // Logged so any send path still not recording wamids shows up, instead of only surfacing
        // as a confused reply.
        console.warn("quotedMessage: swipe-reply to an unrecorded message", { ownerId, quotedMessageId });
        parts.push(unresolvedQuoteNote(ownerId, phone));
      }
    }
  }

  if (forwarded) {
    parts.push("[This message was forwarded from another chat.]");
  }

  return parts.length ? parts.join(" ") : null;
}

// Without the quoted text, the model used to grab whatever was most prominent in context and
// answer about that with confidence. Showing its own recent messages lets it match the swipe the
// way a person would, and the instruction rules out answering about anything else on a guess.
function unresolvedQuoteNote(ownerId: number, phone: string | undefined): string {
  const recent = phone
    ? getRecentWhatsAppMessagesForOwner(ownerId, phone, RECENT_CANDIDATES * 4)
        .filter((m) => m.role === "assistant")
        .slice(-RECENT_CANDIDATES)
    : [];
  const listed = recent
    .map((m, i) => {
      const sentAt = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const text = m.content.length > MAX_CANDIDATE_CHARS ? `${m.content.slice(0, MAX_CANDIDATE_CHARS)}…` : m.content;
      return `${i + 1}. (${sentAt} UTC) "${text}"`;
    })
    .join("\n");

  const howToAnswer = listed
    ? `Your most recent messages, oldest first:\n${listed}\nIf their message clearly fits one of ` +
      "these, answer about that one and say briefly which you took it to be, so they can correct " +
      "you. Otherwise ask which message they mean. "
    : "Ask which message they mean. ";
  return (
    "[The user swipe-replied to an earlier message, but you can't see which one — it wasn't " +
    `recorded. ${howToAnswer}Never answer on a guess about something that isn't shown here (an ` +
    "email, an alert, an earlier topic), and don't make up a reason why you can't see it — just " +
    "say you couldn't tell which message it was.]"
  );
}
