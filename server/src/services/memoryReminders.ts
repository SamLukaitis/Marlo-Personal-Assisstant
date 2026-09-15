// Out-of-band proactive memory surfacing — a scheduled push when a memory's trigger_at arrives,
// the same shape as the existing real-time email alerts (alerts.ts). See
// docs/superpowers/specs/2026-08-24-proactive-memory-surfacing-design.md.

import {
  listDueMemoryReminders,
  markMemorySurfaced,
  listMemoryRemindersToGiveUpOn,
  markMemoryGivenUp,
  listPhoneNumbersForUser,
} from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { sendToAllNumbers } from "./proactiveDelivery.js";

const MAX_REMINDERS_PER_CHECK = 5;

export async function checkDueMemoryReminders(ownerId: number): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const due = listDueMemoryReminders(ownerId, Date.now());
  const givenUp = listMemoryRemindersToGiveUpOn(ownerId, Date.now());
  if (due.length === 0 && givenUp.length === 0) return;

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // Capped per tick, not per reminder ever: anything past the cap is simply still "due" (ordered
  // oldest-first) on the next 5-minute tick, so a burst naturally drains over a few ticks instead
  // of firing a wall of messages — no separate overflow bookkeeping needed.
  const toSend = due.slice(0, MAX_REMINDERS_PER_CHECK);

  for (const note of toSend) {
    const text = `💭 Just remembered: ${note.content}`;
    const itemKey = `memory-reminder:${note.id}:${note.triggerAt}`;
    const allSucceeded = await sendToAllNumbers(ownerId, itemKey, numbers, text, "alert", "memoryReminders");
    // Only stamp last_surfaced_at once every number actually got it — a partial/total failure
    // means this reminder stays due and is retried on the next tick (only to the numbers that
    // missed it — see proactiveDelivery.ts), rather than being
    // silently half-delivered or lost. Deliberately different from alerts.ts's notify(), which
    // marks unconditionally — see the design doc for why that's the wrong call for a one-time,
    // time-sensitive reminder.
    if (allSucceeded) {
      markMemorySurfaced(ownerId, note.id);
    }
  }

  await notifyGivenUpReminders(ownerId, numbers, givenUp);
}

// The other half of the give-up tradeoff in listDueMemoryReminders: a reminder that fails to send
// for 24h straight ages out of that query silently. Rather than leave the user to discover a
// reminder never arrived, tell them once it's given up on — best-effort, same channel as the
// reminder itself would have used. If WhatsApp is down badly enough that even this fails, the
// reminder is still marked given-up (so this doesn't retry forever) and check_reminder_status
// remains the backstop for the user to ask directly.
async function notifyGivenUpReminders(
  ownerId: number,
  numbers: string[],
  givenUp: { id: number; content: string }[]
): Promise<void> {
  for (const note of givenUp.slice(0, MAX_REMINDERS_PER_CHECK)) {
    const text = `⚠️ I wasn't able to get this reminder out in time: "${note.content}"`;
    for (const number of numbers) {
      try {
        await sendProactiveMessage(number, text, "alert");
      } catch (err) {
        console.error("memoryReminders: failed to send give-up notice", err);
      }
    }
    // Marked given-up regardless of whether the notice itself sent — this is a one-shot notice,
    // not a reminder, so it doesn't get its own retry loop (see file comment above).
    markMemoryGivenUp(ownerId, note.id);
  }
}
