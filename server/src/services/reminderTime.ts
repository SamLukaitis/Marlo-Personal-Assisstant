// All reminder date/time arithmetic lives here, deliberately isolated from the assistant loop:
// the model's only job is to copy the numbers/clock-times the user said out of their sentence
// (ai/assistant.ts's set_reminder tool description says so explicitly) — every actual computation
// (adding minutes, converting a local wall-clock time to an absolute instant, rolling over to
// tomorrow) happens here, in plain deterministic code. This is the fix for "the AI is bad at time
// math": take the math away from it entirely.
import { DateTime } from "luxon";

export class ReminderTimeError extends Error {}

export interface OnceInput {
  mode: "once";
  relativeMinutes?: number;
  localTime?: string; // "HH:mm"
  localDate?: string; // "YYYY-MM-DD", optional — omitted means "today, or tomorrow if already past"
}

export interface IntervalInput {
  mode: "interval";
  localTime: string; // window start, "HH:mm"
  localDate?: string;
  windowEndLocalTime: string; // "HH:mm", same calendar day as the resolved start
  intervalMinutes: number;
}

export interface UntilReplyInput {
  mode: "until_reply";
  intervalMinutes: number;
}

export type ReminderTimeInput = OnceInput | IntervalInput | UntilReplyInput;

export interface ResolvedReminderTime {
  nextFireAt: number;
  intervalMs?: number;
  windowEndAt?: number;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseHHMM(value: string): { hour: number; minute: number } {
  const match = HHMM.exec(value.trim());
  if (!match) throw new ReminderTimeError(`"${value}" isn't a valid 24-hour time (expected HH:mm)`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// Resolves a local wall-clock time to an absolute instant. With no localDate, "today" is assumed
// and rolled forward to tomorrow if that time has already passed — the same judgment call a human
// makes for "remind me at 3pm" said at 4pm, done with real date arithmetic instead of the model
// guessing what day it is.
function resolveLocalClockTime(
  localTime: string,
  localDate: string | undefined,
  timezone: string,
  nowMs: number
): DateTime {
  const { hour, minute } = parseHHMM(localTime);
  const base = localDate
    ? DateTime.fromISO(localDate, { zone: timezone })
    : DateTime.fromMillis(nowMs, { zone: timezone });
  if (!base.isValid) {
    throw new ReminderTimeError(`"${localDate}" isn't a valid date (expected YYYY-MM-DD)`);
  }
  let dt = base.set({ hour, minute, second: 0, millisecond: 0 });
  if (!localDate && dt.toMillis() <= nowMs) {
    dt = dt.plus({ days: 1 });
  }
  return dt;
}

export function resolveReminderTime(
  input: ReminderTimeInput,
  timezone: string,
  nowMs: number = Date.now()
): ResolvedReminderTime {
  switch (input.mode) {
    case "once": {
      if (input.relativeMinutes != null) {
        if (!(input.relativeMinutes > 0)) {
          throw new ReminderTimeError("relativeMinutes must be a positive number");
        }
        return { nextFireAt: nowMs + input.relativeMinutes * 60_000 };
      }
      if (input.localTime) {
        return { nextFireAt: resolveLocalClockTime(input.localTime, input.localDate, timezone, nowMs).toMillis() };
      }
      throw new ReminderTimeError("A one-shot reminder needs either relativeMinutes or localTime");
    }
    case "interval": {
      if (!(input.intervalMinutes > 0)) {
        throw new ReminderTimeError("intervalMinutes must be a positive number");
      }
      const start = resolveLocalClockTime(input.localTime, input.localDate, timezone, nowMs);
      const { hour, minute } = parseHHMM(input.windowEndLocalTime);
      // Anchored to the SAME calendar day start resolved to (not re-derived from `now`) — if
      // "now" falls inside the window, an independent rollover check on the end time alone could
      // put it on a different day than the start, e.g. start rolls to tomorrow while end (still
      // in the future today) doesn't.
      const end = start.set({ hour, minute, second: 0, millisecond: 0 });
      if (end.toMillis() <= start.toMillis()) {
        throw new ReminderTimeError("windowEndLocalTime must be after localTime");
      }
      return {
        nextFireAt: start.toMillis(),
        intervalMs: input.intervalMinutes * 60_000,
        windowEndAt: end.toMillis(),
      };
    }
    case "until_reply": {
      if (!(input.intervalMinutes > 0)) {
        throw new ReminderTimeError("intervalMinutes must be a positive number");
      }
      return { nextFireAt: nowMs, intervalMs: input.intervalMinutes * 60_000 };
    }
  }
}
