// Bookings the user saved (a boarding pass, a hotel confirmation — documents.ts extracts them as
// `booking` entities) become timed reminders in the attention gate: flight check-in the day before,
// hotel on check-in morning. The gate owns timing, quiet hours and dedupe with the same booking's
// confirmation email; this just hands each future booking over once.
import { DateTime } from "luxon";
import { listEntities, updateEntity } from "../db/store.js";
import { submitAttentionItem } from "./attention.js";
import { userLocalClock } from "./userTimezone.js";
import type { BookingData } from "./entityValidation.js";

export function flightNumberFrom(name: string): string | null {
  const match = name.match(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

function shortDate(date: string): string {
  const parsed = DateTime.fromISO(date);
  return parsed.isValid ? parsed.toFormat("d LLL") : date;
}

export function bookingSummary(data: BookingData): string {
  const ref = data.reference ? `, ref *${data.reference}*` : "";
  if (data.kind === "flight") return `Your flight *${data.name}* on *${shortDate(data.startDate)}*${ref}.`;
  const until = data.endDate ? ` to *${shortDate(data.endDate)}*` : "";
  return `Your stay at *${data.name}* from *${shortDate(data.startDate)}*${until}${ref}.`;
}

export async function syncBookingReminders(ownerId: number): Promise<void> {
  const today = userLocalClock(ownerId).dateKey;
  for (const booking of listEntities<BookingData>(ownerId, { type: "booking" })) {
    const data = booking.data;
    if (data.tripPrepNotifiedAt || data.startDate < today) continue;
    await submitAttentionItem(ownerId, {
      source: "booking",
      category: "reservation_confirmed",
      details: {
        summary: bookingSummary(data),
        kind: data.kind,
        eventStart: data.startDate,
        reference: data.reference,
        flightNumber: data.kind === "flight" ? flightNumberFrom(data.name) : null,
        merchant: data.kind === "hotel" ? data.name : null,
        bookingEntityId: booking.id,
      },
      fallbackKey: `booking:${booking.id}`,
      // The user sent us this document themselves and already got a "saved" reply.
      acknowledged: true,
    });
    // Marks "handed to the attention gate", so it's never submitted twice.
    updateEntity<BookingData>(ownerId, booking.id, { data: { ...data, tripPrepNotifiedAt: Date.now() } });
  }
}
