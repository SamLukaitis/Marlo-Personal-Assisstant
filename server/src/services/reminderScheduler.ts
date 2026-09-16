// The "accurate clock" for reminders: a tight, dedicated, deterministic timer — separate from
// scheduler.ts's 5-minute tick (too coarse for a reminder someone expects "in 2 minutes" or
// "every minute"). Nothing here reasons about time; it only compares Date.now() against
// next_fire_at values that services/reminderTime.ts already computed exactly.
import {
  listAllUserIds,
  listPhoneNumbersForUser,
  listDueRemindersForOwner,
  advanceReminderAfterSend,
  listRemindersToGiveUpOnForOwner,
  markReminderGivenUp,
  type ReminderRow,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";

const REMINDER_CHECK_INTERVAL_MS = 15 * 1000;
const UNTIL_REPLY_GIVE_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REMINDERS_PER_TICK = 10;

async function sendDueReminders(ownerId: number, numbers: string[], due: ReminderRow[]): Promise<void> {
  // Capped per tick, not per reminder ever: anything past the cap stays due (ordered
  // soonest-first) and is retried on the next 15s tick, so a burst drains naturally instead of
  // needing separate overflow bookkeeping — same spirit as the old memoryReminders.ts.
  for (const reminder of due.slice(0, MAX_REMINDERS_PER_TICK)) {
    // Keyed on this occurrence (next_fire_at moves on once it's sent), so the retry below reaches
    // only the numbers that actually missed it — see proactiveDelivery.ts.
    const itemKey = `reminder:${reminder.id}:${reminder.nextFireAt}`;
    const succeeded = await sendToAllNumbers(
      ownerId,
      itemKey,
      numbers,
      `⏰ ${reminder.message}`,
      "alert",
      "reminderScheduler"
    );
    // Only advance (mark done / schedule the next occurrence) once every number actually got it —
    // a failed send leaves next_fire_at untouched so it's retried next tick, rather than silently
    // skipping an occurrence.
    if (succeeded) {
      advanceReminderAfterSend(reminder.id);
    }
  }
}

async function giveUpOnStaleUntilReplyReminders(ownerId: number, numbers: string[]): Promise<void> {
  const cutoff = Date.now() - UNTIL_REPLY_GIVE_UP_WINDOW_MS;
  const stale = listRemindersToGiveUpOnForOwner(ownerId, cutoff);
  for (const reminder of stale.slice(0, MAX_REMINDERS_PER_TICK)) {
    await sendToAllNumbers(
      ownerId,
      `reminder-give-up:${reminder.id}`,
      numbers,
      `⚠️ I've been trying to remind you about this for 24 hours with no reply, so I'm stopping: "${reminder.message}"`,
      "alert",
      "reminderScheduler"
    );
    // Marked given-up regardless of whether the notice itself sent — this is a one-shot notice,
    // not a reminder, so it doesn't get its own retry loop.
    markReminderGivenUp(reminder.id);
  }
}

// Exported for its own unit test — same reasoning as memoryReminders.ts's old
// checkDueMemoryReminders: lets tests exercise one owner in isolation, since listAllUserIds()
// (used by the real tick) would otherwise pick up every user created by every other test file
// sharing this run's SQLite database (see test/setup.ts).
export async function runReminderCheckForOwner(ownerId: number): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  const due = listDueRemindersForOwner(ownerId, Date.now());
  if (due.length > 0) {
    await sendDueReminders(ownerId, numbers, due);
  }
  await giveUpOnStaleUntilReplyReminders(ownerId, numbers);
}

async function reminderTick(): Promise<void> {
  for (const ownerId of listAllUserIds()) {
    await runReminderCheckForOwner(ownerId).catch((err) =>
      console.error(`reminderScheduler: check failed for user ${ownerId}`, err)
    );
  }
}

// Same self-rescheduling, re-entrancy-guarded shape as scheduler.ts's tickGuarded — at multi-
// tenant scale a full pass could in principle exceed the interval, and a raw setInterval would
// then start an overlapping tick on top of it (double-sending reminders) with no second process
// required.
let reminderTickInFlight = false;

export async function reminderTickGuarded(): Promise<void> {
  if (reminderTickInFlight) return;
  reminderTickInFlight = true;
  try {
    await reminderTick();
  } finally {
    reminderTickInFlight = false;
  }
}

export function startReminderScheduler(): void {
  void reminderTickGuarded();
  setInterval(() => void reminderTickGuarded(), REMINDER_CHECK_INTERVAL_MS);
}
