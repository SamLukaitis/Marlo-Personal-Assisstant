import { consumePendingLeave, leaveFamily, setOnboardingState } from "./registry.js";
import { openFamilySessionForPhone } from "./familyDb.js";
import { deleteMyGoogleAccount } from "./store.js";
import { revokeJoyceGoogleToken } from "./googleCalendar.js";
import { onMemberLeaving } from "./familyCalendar.js";
import { fireFamilyLeaving, fireFamilyLeft } from "./hooks.js";

// Leaving a family, in two steps.
//
// The split matters. *Recognising* that someone wants to leave is a judgement call — "I want out
// of this group", "take me off this", "can I leave the family thing" — so the model makes it, via
// the request_leave_family tool. *Acting* on it is not a judgement call, so the model has no part
// in it: the confirmation below is matched in plain code, before the model runs, and the model is
// never told whether it matched. There is no tool that removes anyone from a family, so no
// amount of confused reasoning or injected text in a forwarded message can talk Joyce into it.
//
// The same reasoning as the email-sending rule in Marlo: an action you can't undo doesn't get
// exposed to the assistant as something it can decide to do.

const CONFIRM_PHRASE = "confirm cancel";

export const LEAVE_WARNING =
  "Before I do that, please read this carefully.\n\n" +
  "If you leave:\n" +
  "• You'll lose access to everything this family has saved — notes, documents, reminders, all " +
  "of it.\n" +
  "• Anything *you* added stays with the family. You can't take it out with you.\n" +
  "• You'll need the family ID again to come back, and only someone still in the family can " +
  "give it to you.\n\n" +
  'If you\'re sure, reply with exactly: *confirm cancel*\n\n' +
  "Anything else and I'll leave everything as it is.";

export const LEFT_MESSAGE =
  "Okay, you've left. Let me know if you want to join another family or rejoin a family.";

export const NOT_CONFIRMED_MESSAGE = "No exact match, request cancelled.";

/**
 * Case and surrounding whitespace are forgiven; nothing else is. Phone keyboards capitalise the
 * first letter of a message by default, so requiring a literal lowercase "confirm cancel" would
 * reject most people's first honest attempt and read as a bug — while doing nothing for safety,
 * since the protection here is that the phrase is specific and unprompted, not that it's
 * lowercase. Extra words still fail: "yes confirm cancel" is not a match.
 */
export function isLeaveConfirmation(text: string): boolean {
  return text.trim().toLowerCase() === CONFIRM_PHRASE;
}

export interface LeaveOutcome {
  reply: string;
  /** True only when they actually left, so the caller knows whether a family still exists. */
  left: boolean;
}

/**
 * Handles the message immediately following a leave request, if there is a live one. Returns
 * null when this number has no pending request and the message should be treated normally.
 *
 * Called before anything else in composeReply, so the confirmation can never reach the model —
 * and so that a pending request is spent by the very next message whatever it says.
 */
export function handlePendingLeave(
  normalizedPhone: string,
  text: string
): LeaveOutcome | null {
  if (!consumePendingLeave(normalizedPhone)) return null;

  if (!isLeaveConfirmation(text)) return { reply: NOT_CONFIRMED_MESSAGE, left: false };

  // Their notes and documents stay with the family, but their calendar doesn't: it's still
  // their live Google account, and the family shouldn't keep reading and editing it after
  // they've gone. Done before leaving, while there's still a session to reach the row through.
  // If they own the family calendar, the family stops using it — it stays in their Google
  // account after they've gone. Otherwise they're unshared from it. See joyce/familyCalendar.ts.
  const session = openFamilySessionForPhone(normalizedPhone);
  if (session) onMemberLeaving(session);
  const google = session ? deleteMyGoogleAccount(session) : null;
  if (google) {
    revokeJoyceGoogleToken(google).catch((err) =>
      console.error("joyce: couldn't revoke Google token on leaving", err)
    );
  }

  fireFamilyLeaving(normalizedPhone);

  if (!leaveFamily(normalizedPhone)) {
    // Only reachable if they were removed by something else between asking and confirming.
    return { reply: "You're not in a family group at the moment.", left: false };
  }

  fireFamilyLeft(normalizedPhone);

  // Skip the introduction next time they write: they've just met Joyce, and LEFT_MESSAGE already
  // asks the new-or-join question, so their next message should be read as the answer to it.
  setOnboardingState(normalizedPhone, "awaiting_choice");
  return { reply: LEFT_MESSAGE, left: true };
}
