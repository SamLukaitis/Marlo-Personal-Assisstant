import { randomUUID } from "node:crypto";
import { getSetting, setSetting } from "../db/store.js";
import { WATCH_MATCH_CATEGORY } from "./attentionRules.js";

// Topics the user asked Marlo to keep an eye out for ("tell me when Jazz Fest tickets go on sale") —
// the opposite of a mute (emailAlertSettings.ts). Matched by meaning, not keywords: the active
// watches ride along on the model calls that already read new mail (importantEmailClassifier.ts for
// automated mail, realPersonTriage.ts for people), and a match pings at once through the attention
// gate. Watches work even when the user has switched email alerts off (scheduler.ts runs the scans
// in watch-only mode). Managed in chat only (assistant.ts's watch_emails). See
// docs/superpowers/specs/2026-10-27-email-watches-design.md.
export interface EmailWatch {
  id: string;
  // Short name shown in the alert, e.g. "Jazz Fest tickets".
  label: string;
  // What counts as a match, in plain English, for the model reading the mail.
  topic: string;
  createdAt: number;
  // Alerts sent since the watch was created or the user last said to keep it — every
  // CHECK_IN_EVERY-th one asks whether they still want it.
  alertCount: number;
}

export const WATCH_CATEGORY = WATCH_MATCH_CATEGORY;
export const CHECK_IN_EVERY = 3;

const WATCHES_KEY = "email_watches";
const MAX_WATCHES = 20;
const MAX_LABEL = 60;
const MAX_TOPIC = 300;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim().slice(0, max);
  return flat || undefined;
}

export function listEmailWatches(ownerId: number): EmailWatch[] {
  try {
    const parsed = JSON.parse(getSetting(ownerId, WATCHES_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((w) => w && typeof w.id === "string" && w.label && w.topic)
      : [];
  } catch {
    return [];
  }
}

function save(ownerId: number, watches: EmailWatch[]): void {
  setSetting(ownerId, WATCHES_KEY, JSON.stringify(watches.slice(-MAX_WATCHES)));
}

export function hasEmailWatches(ownerId: number): boolean {
  return listEmailWatches(ownerId).length > 0;
}

// Returns the new watch, or null when label or topic has no text.
export function addEmailWatch(ownerId: number, input: { label?: unknown; topic?: unknown }): EmailWatch | null {
  const label = clean(input.label, MAX_LABEL);
  const topic = clean(input.topic, MAX_TOPIC) ?? label;
  if (!label || !topic) return null;
  const watch: EmailWatch = { id: randomUUID().slice(0, 8), label, topic, createdAt: Date.now(), alertCount: 0 };
  save(ownerId, [...listEmailWatches(ownerId), watch]);
  return watch;
}

export function removeEmailWatch(ownerId: number, id: unknown): EmailWatch | null {
  const all = listEmailWatches(ownerId);
  const found = all.find((w) => w.id === id);
  if (!found) return null;
  save(ownerId, all.filter((w) => w.id !== id));
  return found;
}

// The user answered a check-in with "yes, keep them coming": the next one comes CHECK_IN_EVERY
// alerts from now.
export function keepEmailWatch(ownerId: number, id: unknown): EmailWatch | null {
  const all = listEmailWatches(ownerId);
  const found = all.find((w) => w.id === id);
  if (!found) return null;
  found.alertCount = 0;
  save(ownerId, all);
  return found;
}

// Counts one more alert for the watch and says whether this one should carry the check-in. Counted
// when the alert is handed to the attention gate, not on delivery — one held overnight still counts.
// An unanswered check-in changes nothing: the count keeps rising and it asks again 3 alerts later.
export function recordWatchAlert(ownerId: number, id: string): boolean {
  const all = listEmailWatches(ownerId);
  const found = all.find((w) => w.id === id);
  if (!found) return false;
  found.alertCount += 1;
  save(ownerId, all);
  return found.alertCount % CHECK_IN_EVERY === 0;
}

// The alert body: "*Jazz Fest tickets*: <summary>", plus the check-in question when it's due. The
// bold label also keeps attentionRules.ts's isConcrete happy whatever the summary says.
export function watchAlertSummary(watch: EmailWatch, summary: string, checkIn: boolean): string {
  const body = summary.trim().replace(/([^.!?])$/, "$1.");
  const question = checkIn ? ` Still want me flagging ${watch.label} emails?` : "";
  return `*${watch.label}*: ${body}${question}`;
}

// The list as the classifier/triage prompts show it.
export function watchPromptLines(watches: EmailWatch[]): string {
  return watches.map((w) => `- ${w.id}: ${w.topic}`).join("\n");
}
