// Out-of-band proactive memory surfacing — a scheduled push when a memory's trigger_at arrives,
// the same shape as the existing real-time email alerts (alerts.ts). See
// docs/superpowers/specs/2026-08-24-proactive-memory-surfacing-design.md.

import { listDueMemoryReminders, markMemorySurfaced, listPhoneNumbersForUser } from "../db/store.js";
import { sendWhatsAppMessage, isWhatsAppConfigured } from "../providers/whatsapp.js";

const MAX_REMINDERS_PER_CHECK = 5;

export async function checkDueMemoryReminders(ownerId: number): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const due = listDueMemoryReminders(ownerId, Date.now());
  if (due.length === 0) return;

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  // Capped per tick, not per reminder ever: anything past the cap is simply still "due" (ordered
  // oldest-first) on the next 5-minute tick, so a burst naturally drains over a few ticks instead
  // of firing a wall of messages — no separate overflow bookkeeping needed.
  const toSend = due.slice(0, MAX_REMINDERS_PER_CHECK);

  for (const note of toSend) {
    const text = `💭 Just remembered: ${note.content}`;
    let allSucceeded = true;
    for (const number of numbers) {
      try {
        await sendWhatsAppMessage(number, text);
      } catch (err) {
        console.error("memoryReminders: failed to send reminder", err);
        allSucceeded = false;
      }
    }
    // Only stamp last_surfaced_at once every number actually got it — a partial/total failure
    // means this reminder stays due and is retried in full on the next tick, rather than being
    // silently half-delivered or lost. Deliberately different from alerts.ts's notify(), which
    // marks unconditionally — see the design doc for why that's the wrong call for a one-time,
    // time-sensitive reminder.
    if (allSucceeded) {
      markMemorySurfaced(ownerId, note.id);
    }
  }
}
