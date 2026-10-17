import type { FamilySession } from "./familyDb.js";
import type { JoyceButton, JoyceMessage } from "./messages.js";
import { collectDerived, deleteItems, describeItems } from "./provenance.js";
import { getFamilyAdminId, getMessage, setPendingDelete, takePendingDelete, type StoredMessage } from "./store.js";

// Deleting a message, and everything made from it, from the family's memory.
//
// Like leaving a family (leaving.ts), it's two steps. *Recognising* the request is the model's
// job — usually someone swipe-replies to their own message with "delete this" — through the
// request_delete tool, which only starts a confirmation. *Acting* on it is plain code: the
// confirmation is matched here before the model runs, and no tool deletes a message.
//
// Who may delete a message: whoever sent it, or the family admin (whoever started the family) —
// and only within 24 hours of it being sent, for everyone. A message that's been around longer has
// usually been built on: deleting a year-old message could take a large part of a family's memory
// with it. Older ones need a developer (scripts/joyceDeleteMessage.ts), who can see what would go
// first. Checked when it's asked for and again when it's confirmed.
//
// This removes it from Joyce's memory only. WhatsApp gives a business no way to delete messages
// from people's phones, so the message itself stays in their chat — Joyce says so.

export const DELETE_BUTTONS: JoyceButton[] = [
  { id: "joyce_delete_confirm", title: "Delete" },
  { id: "joyce_delete_keep", title: "Keep" },
];

export type DeleteRequestOutcome =
  | { ok: true; confirmation: JoyceMessage }
  | { ok: false; reason: string };

export const DELETE_WINDOW_MS = 24 * 60 * 60 * 1000;

const TOO_OLD =
  "That was sent more than 24 hours ago, so I can't delete it myself — older messages often have " +
  "other things built on them. If it needs to go, ask the team and a developer can remove it.";

const NOT_YOURS = "Only the person who sent that, or whoever started the family group, can delete it.";

/** Why this member can't delete this message, or null if they can. */
function refusal(session: FamilySession, target: StoredMessage, now: number): string | null {
  if (target.memberId !== session.actor.id && getFamilyAdminId(session) !== session.actor.id) return NOT_YOURS;
  if (now - target.createdAt > DELETE_WINDOW_MS) return TOO_OLD;
  return null;
}

/** Checks the request and, if it's allowed, arms the confirmation and returns what to ask. */
export function requestDelete(
  session: FamilySession,
  target: StoredMessage | null,
  now = Date.now(),
  /** The member's own "delete this" message, which goes too once it's done — it often names what was deleted. */
  requestMessageId: number | null = null
): DeleteRequestOutcome {
  if (!target) {
    return {
      ok: false,
      reason:
        "I couldn't find that message. To delete something, swipe-reply to the message or file " +
        "you sent and say \"delete this\".",
    };
  }
  if (target.role !== "user") {
    return {
      ok: false,
      reason:
        "That's one of my messages. Swipe-reply to the message or file you sent instead, and I'll " +
        "delete that and everything I made from it.",
    };
  }
  const refused = refusal(session, target, now);
  if (refused) return { ok: false, reason: refused };

  const lines = describeItems(session, collectDerived(session, { type: "message", id: target.id }));
  setPendingDelete(session, { messageId: target.id, requestMessageId });
  return {
    ok: true,
    confirmation: {
      text:
        "This will permanently remove from my memory:\n" +
        lines.map((l) => `• ${l}`).join("\n") +
        "\n\nNobody in the family will be able to find it through me again. It stays in the " +
        "WhatsApp chat itself, which I can't change. Delete it?",
      buttons: DELETE_BUTTONS,
    },
  };
}

/**
 * Handles the message right after a delete request, if there is a live one: "Delete" (the button,
 * or typed) carries it out, anything else keeps everything. Returns null when nothing is pending.
 */
export function handlePendingDelete(session: FamilySession, text: string, now = Date.now()): string | null {
  const pending = takePendingDelete(session, now);
  if (pending === null) return null;
  if (text.trim().toLowerCase() !== "delete") return "Okay, I've kept it.";

  const target = getMessage(session, pending.messageId);
  if (!target) return "That's already gone.";
  const refused = refusal(session, target, now);
  if (refused) return refused;
  const removed = deleteItems(session, collectDerived(session, { type: "message", id: target.id }));
  // The request itself ("delete this, it had my PIN in it", "delete what Sam said about the
  // bank") and Joyce's record of asking to confirm, so nothing points back at what was removed.
  if (pending.requestMessageId !== null) {
    deleteItems(session, collectDerived(session, { type: "message", id: pending.requestMessageId }));
  }
  const others = removed - 1;
  return others > 0
    ? `Deleted. I've removed it and ${others} thing${others === 1 ? "" : "s"} I'd made from it.`
    : "Deleted.";
}
