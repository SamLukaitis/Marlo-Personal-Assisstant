// Joyce's two questions about who is away and who is free. Both answer from what members' Marlowes
// chose to share (joyce/trips.ts) or will say (the availability hook), and are worded so the family
// can't tell why Joyce knows nothing about someone: no Marlowe, sharing off, declined and "couldn't
// tell" all read "nothing shared" / "not sure".
import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { FamilySession } from "./familyDb.js";
import { getFamilyZone } from "./familyTime.js";
import { askAvailability, type AvailabilityAnswer } from "./hooks.js";
import { listMemberPhones, listTripsOverlapping } from "./trips.js";

const MAX_RANGE_DAYS = 31;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const TRIP_TOOLS: Anthropic.Tool[] = [
  {
    name: "who_is_away",
    description:
      "Who in the family is away between two dates, from the trips members chose to share: dates, and " +
      "the country only when they allowed it. Use when someone asks when a person is away or whether " +
      "anyone is travelling. It cannot say where in a country, or anything about a booking. Dates are " +
      "YYYY-MM-DD in the family's local calendar; call get_current_time first for relative dates.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD." },
        to: { type: "string", description: "Last day, YYYY-MM-DD (the same as from for a single day)." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "check_availability",
    description:
      `Ask each family member's Marlowe whether they're free for proposed dates (at most ${MAX_RANGE_DAYS} ` +
      "days). Use when someone asks whether dates work for everyone or for a person. Each answer is only " +
      "free, busy, free except certain days, or not sure; it never says why. Dates are YYYY-MM-DD in the " +
      "family's local calendar.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD." },
        to: { type: "string", description: "Last day, YYYY-MM-DD (the same as from for a single day)." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
];

export const TRIP_TOOL_NAMES: ReadonlySet<string> = new Set(TRIP_TOOLS.map((t) => t.name));

function readRange(input: Record<string, unknown>): { from: string; to: string } | string {
  const from = String(input.from ?? "").trim();
  const to = String(input.to ?? from).trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || !DateTime.fromISO(from).isValid || !DateTime.fromISO(to).isValid) {
    return "Dates must be YYYY-MM-DD. Work out the dates and try again, or ask them.";
  }
  if (to < from) return "The end date is before the start date. Check the dates with them.";
  const days = DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days + 1;
  if (days > MAX_RANGE_DAYS) return `That's more than ${MAX_RANGE_DAYS} days. Ask them to narrow it down.`;
  return { from, to };
}

function shortDate(date: string): string {
  return DateTime.fromISO(date).toFormat("d LLL");
}

function span(start: string, end: string): string {
  return start === end ? shortDate(start) : `${shortDate(start)}–${shortDate(end)}`;
}

const REMINDER =
  "Report only what's above. Never say anyone is or isn't away, or is or isn't free, beyond it, and " +
  "never guess where someone is or why they're busy.";

export function whoIsAway(session: FamilySession, from: string, to: string): string {
  const trips = listTripsOverlapping(session, from, to);
  const lines: string[] = [];
  const named = new Set<number>();
  for (const t of trips) {
    named.add(t.memberId);
    lines.push(
      `${t.memberName ?? "Someone"} is away ${span(t.startDate, t.endDate)}${t.country ? ` (${t.country})` : ""}.`
    );
  }
  for (const m of listMemberPhones(session)) {
    if (!named.has(m.id)) lines.push(`Nothing is shared for ${m.name ?? "someone who hasn't given a name"}.`);
  }
  return `${lines.join("\n")}\n\n${REMINDER}`;
}

function describe(name: string, answer: AvailabilityAnswer): string {
  switch (answer.status) {
    case "free":
      return `${name}: free on all of those days.`;
    case "busy":
      return `${name}: busy on all of those days.`;
    case "free_except":
      return `${name}: free except ${answer.busyDates.map(shortDate).join(", ")}.`;
    default:
      return `I'm not sure about ${name}.`;
  }
}

export async function checkAvailability(session: FamilySession, from: string, to: string): Promise<string> {
  const { zone } = getFamilyZone(session);
  const members = listMemberPhones(session);
  const answers = await Promise.all(
    members.map((m) =>
      m.phone === null ? Promise.resolve<AvailabilityAnswer>({ status: "not_sure" }) : askAvailability(m.phone, from, to, zone)
    )
  );
  const lines = members.map((m, i) => describe(m.name ?? "Someone who hasn't given a name", answers[i]));
  return `For ${span(from, to)}:\n${lines.join("\n")}\n\n${REMINDER}`;
}

export async function runTripTool(
  session: FamilySession,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const range = readRange(input);
  if (typeof range === "string") return range;
  return name === "who_is_away"
    ? whoIsAway(session, range.from, range.to)
    : checkAvailability(session, range.from, range.to);
}
