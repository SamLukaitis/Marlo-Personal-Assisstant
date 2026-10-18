import { openFamiliesWithRemindersDue, syncReminderSchedule, type FamilyData } from "./familyDb.js";
import { recordDerivation } from "./provenance.js";
import {
  appendSentMessage,
  listRemindersToPush,
  markReminderPushAttempted,
  recordReminderDelivery,
  type ReminderRecipient,
  type ReminderToPush,
} from "./store.js";
import {
  JOYCE_WINDOW_CLOSED_ERROR,
  JoyceSendError,
  sendJoyceMessage,
  sendJoyceReminderTemplate,
} from "./whatsapp.js";

// Sends reminders when they come due, instead of waiting for the person to message Joyce.
//
// Once a minute it asks the registry which families have a reminder due (registry.ts's
// reminder_schedule — a time and an opaque id, nothing more), opens just those, and messages
// everyone each due reminder is for:
//   - someone who has messaged Joyce in the last 24 hours gets an ordinary message;
//   - anyone else gets the joyce_reminder template, the only thing WhatsApp allows outside that
//     window. Until Meta approves the template, those sends fail.
// Each reminder gets one go. Anyone it couldn't reach — a failed send, or a member who hasn't
// messaged since phone numbers started being kept — gets it the next time they message Joyce
// (store.ts's claimDueReminders), so a reminder is never lost and never sent twice.

const TICK_MS = 60_000;
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function reminderText(reminder: ReminderToPush, recipient: ReminderRecipient): string {
  const fromSomeoneElse =
    reminder.createdByName && reminder.createdByName !== recipient.name ? ` (from ${reminder.createdByName})` : "";
  return `${reminder.body}${fromSomeoneElse}`;
}

async function sendOne(recipient: ReminderRecipient, text: string, now: number): Promise<void> {
  const phone = recipient.phone!;
  if (now - recipient.lastSeenAt < CUSTOMER_SERVICE_WINDOW_MS) {
    try {
      await sendJoyceMessage(phone, `Reminder: ${text}`);
      return;
    } catch (err) {
      // Our clock said the window was open and Meta disagrees: fall through to the template.
      if (!(err instanceof JoyceSendError && err.code === JOYCE_WINDOW_CLOSED_ERROR)) throw err;
    }
  }
  await sendJoyceReminderTemplate(phone, text);
}

async function deliverForFamily(family: FamilyData, now: number): Promise<void> {
  for (const reminder of listRemindersToPush(family, now)) {
    for (const recipient of reminder.recipients) {
      if (!recipient.phone) continue;
      const text = reminderText(reminder, recipient);
      try {
        await sendOne(recipient, text, now);
        recordReminderDelivery(family, reminder.id, recipient.memberId);
        // In their own conversation, so Joyce knows what they mean if they reply to it.
        const sentId = appendSentMessage(family, recipient.memberId, `Reminder: ${text}`);
        recordDerivation(family, { type: "message", id: sentId }, [{ type: "reminder", id: reminder.id }]);
      } catch (err) {
        console.error("joyce: couldn't send a reminder; they'll get it when they next message", err);
      }
    }
    markReminderPushAttempted(family, reminder.id);
  }
}

/** One pass: sends everything due by `now`. Exported for tests. Never throws. */
export async function deliverDueReminders(now = Date.now()): Promise<void> {
  let families: FamilyData[];
  try {
    families = openFamiliesWithRemindersDue(now);
  } catch (err) {
    console.error("joyce: couldn't look up families with reminders due", err);
    return;
  }
  for (const family of families) {
    try {
      await deliverForFamily(family, now);
    } catch (err) {
      console.error("joyce: reminder delivery failed for a family", err);
    } finally {
      syncReminderSchedule(family);
    }
  }
}

let started = false;

/** Called once at startup (index.ts) when Joyce is configured. */
export function startJoyceReminderDelivery(): void {
  if (started) return;
  started = true;
  // A pass that takes longer than a tick (slow sends) must not overlap the next one, or a
  // reminder could go out twice.
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    deliverDueReminders()
      .catch((err) => console.error("joyce: reminder delivery pass failed", err))
      .finally(() => {
        running = false;
      });
  }, TICK_MS).unref();
}
