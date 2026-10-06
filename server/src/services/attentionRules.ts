// Pure rules for the attention gate (attention.ts): which tier an event gets, how events are
// deduped, when a reminder should fire, quiet hours, and the exact text of every message. No I/O,
// so every decision is unit-testable. See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import { DateTime } from "luxon";
import type { AttentionDetails, AttentionTier } from "../db/store.js";

export const DAILY_CAP = 4;
// Never held by the cap: a flight change or security alert can't wait, and a user who asked for
// every person's email instantly asked for exactly that.
export const CAP_EXEMPT_CATEGORIES = ["flight_change", "security_alert", "person_email"];
// The one category allowed to message during quiet hours.
export const QUIET_HOURS_EXEMPT_CATEGORIES = ["flight_change"];

const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 7;
const REMINDER_HOUR = 9;

const EMOJI: Record<string, string> = {
  flight_change: "✈️",
  reservation_confirmed: "📅",
  invoice_due: "💳",
  government_mail: "🏛️",
  delivery_notification: "📦",
  security_alert: "🔐",
  subscription_renewal: "🔁",
  refund_dispute: "💰",
  document_match: "📎",
  person_email: "📬",
};

function local(ms: number, zone: string | null): DateTime {
  const zoned = zone ? DateTime.fromMillis(ms, { zone }) : DateTime.fromMillis(ms);
  return zoned.isValid ? zoned : DateTime.fromMillis(ms);
}

function fromIso(value: string, zone: string | null): DateTime | null {
  const parsed = zone ? DateTime.fromISO(value, { zone }) : DateTime.fromISO(value);
  if (parsed.isValid) return parsed;
  // An unusable zone name must not lose the date — fall back to the server's zone.
  const fallback = DateTime.fromISO(value);
  return fallback.isValid ? fallback : null;
}

export function parseEventStart(
  value: string | null | undefined,
  zone: string | null
): { ms: number; hasTime: boolean } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const day = fromIso(trimmed, zone);
    return day ? { ms: day.startOf("day").toMillis(), hasTime: false } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return null;
  const parsed = fromIso(trimmed, zone);
  return parsed ? { ms: parsed.toMillis(), hasTime: true } : null;
}

// Whole local calendar days from today to `date` (negative = in the past).
function daysUntil(date: string, now: number, zone: string | null): number | null {
  const target = parseEventStart(date, zone);
  if (!target) return null;
  const today = local(now, zone).startOf("day");
  const day = local(target.ms, zone).startOf("day");
  return Math.round(day.diff(today, "days").days);
}

// An event is over once its day has ended (date-only) or its start time has passed.
function eventOver(eventStart: string | null | undefined, now: number, zone: string | null): boolean | null {
  const parsed = parseEventStart(eventStart, zone);
  if (!parsed) return null;
  if (parsed.hasTime) return parsed.ms < now;
  return local(parsed.ms, zone).endOf("day").toMillis() < now;
}

export function tierFor(category: string, details: AttentionDetails, now: number, zone: string | null): AttentionTier {
  switch (category) {
    case "flight_change":
    case "security_alert":
    case "person_email":
      return "interrupt";
    case "government_mail":
      return details.needsAction ? "interrupt" : "brief";
    case "invoice_due": {
      const days = details.dueDate ? daysUntil(details.dueDate, now, zone) : null;
      if (days === null) return details.needsAction ? "interrupt" : "brief";
      return days <= 2 ? "interrupt" : "scheduled";
    }
    case "reservation_confirmed": {
      const over = eventOver(details.eventStart, now, zone);
      if (over === null) return "brief";
      return over ? "drop" : "scheduled";
    }
    case "subscription_renewal": {
      const days = details.dueDate ? daysUntil(details.dueDate, now, zone) : null;
      if (days === null) return "brief";
      return days < 0 ? "drop" : "scheduled";
    }
    case "delivery_notification":
      return details.needsAction ? "brief" : "drop";
    default:
      return "brief";
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dateOf(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function eventKeyFor(details: AttentionDetails, fallback: string): string {
  const ref = details.reference?.replace(/\s+/g, "").toUpperCase();
  if (ref && ref.length >= 4) return `ref:${ref}`;
  const date = dateOf(details.eventStart) ?? dateOf(details.dueDate);
  const flight = details.flightNumber?.replace(/\s+/g, "").toUpperCase();
  if (flight && date) return `flight:${flight}:${date}`;
  const merchant = details.merchant ? slug(details.merchant) : "";
  if (merchant && date) return `merchant:${merchant}:${date}`;
  return fallback;
}

function atLocalHour(ms: number, zone: string | null, hour: number, dayOffset: number): number {
  return local(ms, zone).startOf("day").plus({ days: dayOffset }).set({ hour, minute: 0 }).toMillis();
}

export function surfaceAtFor(category: string, details: AttentionDetails, zone: string | null): number | null {
  if (category === "subscription_renewal" || category === "invoice_due") {
    const due = parseEventStart(details.dueDate, zone);
    if (!due) return null;
    return atLocalHour(due.ms, zone, REMINDER_HOUR, category === "subscription_renewal" ? -3 : -2);
  }
  const start = parseEventStart(details.eventStart, zone);
  if (!start) return null;
  switch (details.kind) {
    case "flight":
      return start.hasTime ? start.ms - 24 * 60 * 60 * 1000 : atLocalHour(start.ms, zone, REMINDER_HOUR, -1);
    case "hotel":
      return atLocalHour(start.ms, zone, REMINDER_HOUR, 0);
    default:
      return start.hasTime ? start.ms - 3 * 60 * 60 * 1000 : atLocalHour(start.ms, zone, REMINDER_HOUR, 0);
  }
}

export function inQuietHours(ms: number, zone: string | null): boolean {
  const hour = local(ms, zone).hour;
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// When a message due at `ms` may actually go out. An early proactive briefing (07:00–09:00) is the
// natural end of the night, so deferred items wait for it and get folded in instead of pinging first.
export function nextAllowedTime(ms: number, zone: string | null, briefingTime: string | null): number {
  if (!inQuietHours(ms, zone)) return ms;
  const now = local(ms, zone);
  const morning = now.hour >= QUIET_START_HOUR ? now.plus({ days: 1 }).startOf("day") : now.startOf("day");
  let [hour, minute] = [QUIET_END_HOUR, 0];
  if (briefingTime && briefingTime >= "07:00" && briefingTime <= "09:00") {
    [hour, minute] = briefingTime.split(":").map(Number);
  }
  return morning.set({ hour, minute }).toMillis();
}

export function localDayStart(ms: number, zone: string | null): number {
  return local(ms, zone).startOf("day").toMillis();
}

export function formatWhen(ms: number, zone: string | null, now: number): string {
  const when = local(ms, zone);
  const today = local(now, zone).startOf("day");
  const days = Math.round(when.startOf("day").diff(today, "days").days);
  if (days === 0) return `today at ${when.toFormat("HH:mm")}`;
  if (days === 1) return `tomorrow at ${when.toFormat("HH:mm")}`;
  return when.toFormat("ccc d LLL");
}

const BANNED_PHRASES = [
  /worth a look/i,
  /check your inbox/i,
  /important-looking/i,
  /\band \d+ more\b/i,
  /might need attention/i,
  /just ask and i'll run through/i,
];

export function isConcrete(text: string): boolean {
  if (!/\*[^*\s][^*]*\*/.test(text)) return false;
  return !BANNED_PHRASES.some((re) => re.test(text));
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

// "tomorrow at 09:00" reads oddly for a date-level reminder — drop the default hour.
function whenDay(ms: number, zone: string | null, now: number): string {
  return formatWhen(ms, zone, now).replace(/ at 09:00$/, "");
}

export function interruptText(category: string, details: AttentionDetails, reminderMoved: boolean): string {
  const emoji = EMOJI[category] ?? "📌";
  if (category === "person_email") return `${emoji} ${details.summary.trim()}`;
  const moved = reminderMoved ? " Nothing to do — I've moved your reminder." : "";
  return `${emoji} ${sentence(details.summary)}${moved}`;
}

export function reminderText(category: string, details: AttentionDetails, zone: string | null, now: number): string {
  const body = sentence(details.summary);
  const due = parseEventStart(details.dueDate, zone);
  if (category === "subscription_renewal" && due) {
    return `🔁 Reminder: ${body} It charges ${whenDay(atLocalHour(due.ms, zone, REMINDER_HOUR, 0), zone, now)} — tell me if you want to cancel.`;
  }
  if (category === "invoice_due" && due) {
    return `💳 Reminder: ${body} Due ${whenDay(atLocalHour(due.ms, zone, REMINDER_HOUR, 0), zone, now)}.`;
  }
  switch (details.kind) {
    case "flight":
      return `✈️ Reminder: ${body} Online check-in should be open now.`;
    case "hotel":
      return `🏨 Reminder: ${body} Check-in is today.`;
    default:
      return `📅 Reminder: ${body}`;
  }
}

export function ackLine(details: AttentionDetails, surfaceAt: number, zone: string | null, now: number): string {
  const summary = details.summary.trim().replace(/[.!]$/, "").replace(/^Your\b/, "your");
  return `Noted: ${summary} — I'll remind you ${whenDay(surfaceAt, zone, now)}.`;
}

export function briefLine(details: AttentionDetails): string {
  return sentence(details.summary);
}
