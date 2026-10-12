// What Marlowe does once a phone action finishes. These are replies to a tap the user just made,
// so they skip the attention gate. Success is silent (the phone already showed the alarm, the
// Focus change…); a failed step gets one message and is remembered so Marlowe doesn't repeat it;
// report-back values (location, battery, health, a typed answer) go back into the conversation.
import {
  getShortcutStatus,
  setShortcutKnownProblems,
  listPhoneNumbersForUser,
  appendWhatsAppMessage,
  saveCheckin,
  type PhoneActionRow,
  type ShortcutKnownProblem,
} from "../db/store.js";
import { isWhatsAppConfigured, sendWhatsAppMessage } from "../providers/whatsapp.js";
import { queueForAssistant } from "./messageBatching.js";
import { setUserTimezoneFromLocation } from "./userTimezone.js";
import { describeStep, REPORT_STEP_TYPES, type PhoneStep } from "./phoneSteps.js";

export const PROBLEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROBLEMS = 10;

function followupPhone(row: PhoneActionRow): string | null {
  if (!isWhatsAppConfigured()) return null;
  return row.phone ?? listPhoneNumbersForUser(row.ownerId)[0]?.phone ?? null;
}

function locationOf(value: unknown): { latitude: number; longitude: number } | null {
  if (!value || typeof value !== "object") return null;
  const { latitude, longitude } = value as Record<string, unknown>;
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export function formatReportedValue(step: PhoneStep, value: unknown): string | null {
  switch (step.type) {
    case "get_location": {
      const loc = locationOf(value);
      return loc ? `location ${loc.latitude}, ${loc.longitude}` : null;
    }
    case "get_battery":
      return typeof value === "number" ? `battery ${Math.round(value)}%` : null;
    case "get_health": {
      if (typeof value !== "number" && typeof value !== "string") return null;
      return `${step.metric === "sleep_last_night" ? "sleep last night" : "steps today"}: ${String(value).slice(0, 200)}`;
    }
    case "ask":
      return typeof value === "string" ? `answer to "${step.prompt}": ${value.slice(0, 1000)}` : null;
    default:
      return null;
  }
}

function rememberProblem(ownerId: number, problem: ShortcutKnownProblem, now: number): void {
  const status = getShortcutStatus(ownerId);
  if (!status) return;
  const kept = status.knownProblems.filter(
    (p) => now - p.at <= PROBLEM_TTL_MS && !(p.type === problem.type && p.detail === problem.detail)
  );
  setShortcutKnownProblems(ownerId, [...kept, problem].slice(-MAX_PROBLEMS));
}

export async function handleFinishedPhoneAction(row: PhoneActionRow, now: number): Promise<void> {
  const steps = row.steps as unknown as PhoneStep[];
  const phone = followupPhone(row);

  const failed = row.results.find((r) => !r.ok);
  if (failed && steps[failed.index]) {
    const step = steps[failed.index];
    const error = failed.error ?? "it didn't work";
    rememberProblem(row.ownerId, { type: step.type, detail: describeStep(step), error, at: now }, now);
    if (phone) {
      const hint = step.type === "focus" ? " Is there a Focus with exactly that name on your phone?" : "";
      const text = `Couldn't ${describeStep(step)}: ${error}.${hint}`;
      await sendWhatsAppMessage(phone, text);
      appendWhatsAppMessage(row.ownerId, phone, "assistant", text);
    }
  }

  const lines: string[] = [];
  for (const r of row.results) {
    const step = steps[r.index];
    if (!r.ok || !step || !REPORT_STEP_TYPES.includes(step.type)) continue;
    const line = formatReportedValue(step, r.value);
    if (!line) continue;
    lines.push(line);
    const loc = step.type === "get_location" ? locationOf(r.value) : null;
    if (loc) {
      saveCheckin(row.ownerId, { ...loc, country: null, city: null, checkedInAt: now, source: "phone" });
      setUserTimezoneFromLocation(row.ownerId, loc.latitude, loc.longitude);
    }
  }
  if (lines.length && phone) {
    const at = new Date(now).toISOString().slice(11, 16);
    const rowId = appendWhatsAppMessage(row.ownerId, phone, "user", `[From your phone at ${at} UTC, after tapping "${row.label}": ${lines.join("; ")}]`);
    // No inbound wamid to react to or quote — this turn came from the Shortcut, not a WhatsApp message.
    queueForAssistant(row.ownerId, phone, "", rowId, null, true);
  }
}
