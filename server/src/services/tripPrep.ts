// Proactive trip-prep nudges — timing-only (no visa/customs logic): a flight nudge the day
// before departure (when online check-in typically opens) and a hotel nudge the morning of
// check-in day. Separate from the daily morning briefing (briefing.ts), which only mentions
// upcoming travel in passing once a day — this fires once, precisely, per booking. Same shape
// as memoryReminders.ts: read what's due, send, stamp so it never fires twice.
//
// BookingData only stores a calendar date (no time-of-day), so "24h before departure" is
// approximated as "the day before" — timing-only v1, no visa/customs/arrival-requirement logic.

import { listEntities, listPhoneNumbersForUser, updateEntity, type EntityRow } from "../db/store.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";
import { todayKey } from "./dateKey.js";
import type { BookingData } from "./entityValidation.js";

function dateKeyPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Exported for tests — the fire condition is the part of this module worth testing in isolation
// from send plumbing.
export function isTripPrepDue(booking: BookingData, today: string, tomorrow: string): boolean {
  if (booking.tripPrepNotifiedAt) return false;
  if (booking.kind === "flight") {
    // Fires the day before; also catches up same-day if a tick was missed the day before —
    // never fires for a departure date already in the past.
    return booking.startDate === tomorrow || booking.startDate === today;
  }
  // Hotel: fires only on check-in day itself — no catch-up window, kept simple per the design.
  return booking.startDate === today;
}

function tripPrepMessage(data: BookingData): string {
  if (data.kind === "flight") {
    return `✈️ Check-in should be open for ${data.name} — departs ${data.startDate}.`;
  }
  return `🏨 Check-in day for ${data.name}.`;
}

export async function checkTripPrepNudges(ownerId: number): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) return;

  const today = todayKey();
  const tomorrow = dateKeyPlusDays(1);
  const bookings: EntityRow<BookingData>[] = listEntities<BookingData>(ownerId, { type: "booking" });

  for (const booking of bookings) {
    if (!isTripPrepDue(booking.data, today, tomorrow)) continue;

    const text = tripPrepMessage(booking.data);
    let allSucceeded = true;
    for (const number of numbers) {
      try {
        await sendProactiveMessage(number, text, "alert");
      } catch (err) {
        console.error("tripPrep: failed to send nudge", err);
        allSucceeded = false;
      }
    }
    // Only stamp once every number actually got it — same reasoning as memoryReminders.ts: a
    // partial/total failure leaves this booking due again next tick rather than silently lost.
    if (allSucceeded) {
      updateEntity<BookingData>(ownerId, booking.id, {
        data: { ...booking.data, tripPrepNotifiedAt: Date.now() },
      });
    }
  }
}
