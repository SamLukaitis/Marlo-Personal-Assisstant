// The note stored (in chat history only, never sent) alongside an email alert so a later "reply
// yes" or swipe-reply to that alert can be acted on: without the ids the model has to guess which
// mailbox and message the alert was about. Subject and sender are attacker-controlled (anyone can
// email the user), so they are flattened to one line with no quotes or brackets — nothing in them
// can close the note early and read as instructions.
import type { UnifiedMessage } from "../providers/types.js";

const MAX_FIELD_LENGTH = 120;

function plain(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/["[\]]/g, "'").trim().slice(0, MAX_FIELD_LENGTH);
}

export function emailReferenceNote(m: Pick<UnifiedMessage, "id" | "accountId" | "subject" | "from">): string {
  const subject = plain(m.subject);
  return (
    `[Email ref — account_id=${m.accountId}, message_id=${m.id}, from="${plain(m.from)}", ` +
    `subject="${subject}". To reply: send_email to the sender's address, subject "Re: ${subject}".]`
  );
}
