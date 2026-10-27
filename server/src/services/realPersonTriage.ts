// Last check before a "X emailed you" alert goes out (alerts.ts). The provider signals in hub.ts's
// isAutomatedMail catch most bulk mail, but not all of it (a provider that sends no bulk signal, a
// marketer with an ordinary-looking From), and they can't see that a venue's own confirmation email
// repeats the booking-site confirmation the user was already told about. Both are judgement calls,
// so one small model call makes them, biased hard toward alerting — a missed person is worse than
// an extra ping.

import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { tidySnippet } from "./htmlToText.js";
import { watchPromptLines, type EmailWatch } from "./emailWatches.js";

export interface TriageCandidate {
  index: number;
  from: string;
  subject: string;
  snippet: string;
}

export type TriageSkipReason = "not_personal" | "duplicate";

// A few words on what the sender wants, so the digest or ping says "Sarah — wants to move the call"
// instead of just "Sarah emailed you".
export interface TriageGist {
  gist: string;
  needsReply: boolean;
}

// An email about one of the user's watched topics (emailWatches.ts). Read before any skip: a watch
// match always alerts, even when it's marketing.
export interface TriageWatchMatch {
  watchId: string;
  summary: string;
}

export interface TriageResult {
  skips: Map<number, TriageSkipReason>;
  gists: Map<number, TriageGist>;
  watchMatches?: Map<number, TriageWatchMatch>;
}

export function buildTriagePrompt(
  candidates: TriageCandidate[],
  recentAlerts: string[],
  watches: EmailWatch[] = []
): string {
  const recent = recentAlerts.length
    ? `Alerts the user was already sent in the last two days:\n${recentAlerts.map((a) => `- ${a}`).join("\n")}\n\n`
    : "";
  const emailList = candidates
    .map((c) => `[${c.index}] From: ${c.from}\nSubject: ${c.subject}\nSnippet: ${tidySnippet(c.snippet, 400)}`)
    .join("\n\n");
  return (
    `${recent}Each email below is about to trigger a WhatsApp alert telling the user "someone emailed you". ` +
    "Decide which ones should NOT.\n" +
    "- not_personal: a mass mailing rather than someone writing to the user — marketing, promotions, " +
    "discounts or offers, newsletters, social-network or app notifications, surveys, digests.\n" +
    "- duplicate: it only repeats an event one of the already-sent alerts above covers (the same booking, " +
    "order, flight or payment, e.g. the venue's own confirmation of a booking a booking site already " +
    "confirmed). Only when it is clearly the same event and adds nothing new.\n" +
    "A real person writing to the user, or any email that needs their attention and isn't covered by an " +
    "earlier alert, must NOT be skipped. When unsure, do not skip.\n" +
    "For every email you do NOT skip, add it to `kept` with a gist: a few words on what the sender " +
    "wants or says, written to follow their name (e.g. \"wants to move Thursday's call to Friday\", " +
    "\"sent the signed contract\") — concrete, no greeting, no quotes — and needs_reply: true if they " +
    "are waiting on an answer from the user.\n\n" +
    (watches.length
      ? "The user also asked to be told about any email on these topics (id: topic):\n" +
        `${watchPromptLines(watches)}\n` +
        "For each email clearly about one of these topics, add it to watch_matches with that topic's id " +
        "and one plain-English sentence on what it says, addressed to the user, with the concrete specifics " +
        "(names, dates, amounts) in WhatsApp bold (*text*). This applies even to marketing or promotional " +
        "mail — the user asked for exactly this.\n\n"
      : "") +
    emailList
  );
}

export function parseTriageSkips(skips: unknown): Map<number, TriageSkipReason> {
  const result = new Map<number, TriageSkipReason>();
  if (!Array.isArray(skips)) return result;
  for (const entry of skips) {
    const e = entry as { index?: unknown; reason?: unknown } | null;
    if (e && typeof e.index === "number" && (e.reason === "not_personal" || e.reason === "duplicate")) {
      result.set(e.index, e.reason);
    }
  }
  return result;
}

export function parseTriageGists(kept: unknown): Map<number, TriageGist> {
  const result = new Map<number, TriageGist>();
  if (!Array.isArray(kept)) return result;
  for (const entry of kept) {
    const e = entry as { index?: unknown; gist?: unknown; needs_reply?: unknown } | null;
    if (e && typeof e.index === "number" && typeof e.gist === "string" && e.gist.trim()) {
      result.set(e.index, { gist: e.gist.trim(), needsReply: e.needs_reply === true });
    }
  }
  return result;
}

export function parseTriageWatchMatches(entries: unknown, watchIds: string[]): Map<number, TriageWatchMatch> {
  const result = new Map<number, TriageWatchMatch>();
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    const e = entry as { index?: unknown; watch_id?: unknown; summary?: unknown } | null;
    if (e && typeof e.index === "number" && typeof e.watch_id === "string" && watchIds.includes(e.watch_id)) {
      result.set(e.index, { watchId: e.watch_id, summary: typeof e.summary === "string" ? e.summary.trim() : "" });
    }
  }
  return result;
}

const TRIAGE_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const TRIAGE_TOOL: Anthropic.Tool = {
  name: "triage_emails",
  description: "Report which numbered emails should NOT alert, and a gist for every one that should.",
  input_schema: {
    type: "object",
    properties: {
      skips: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The email's number from the list above" },
            reason: { type: "string", enum: ["not_personal", "duplicate"] },
          },
          required: ["index", "reason"],
        },
      },
      kept: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The email's number from the list above" },
            gist: { type: "string", description: "A few words on what the sender wants or says" },
            needs_reply: { type: "boolean" },
          },
          required: ["index", "gist"],
        },
      },
      watch_matches: {
        type: "array",
        description: "Emails about one of the user's watched topics, if any were listed.",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The email's number from the list above" },
            watch_id: { type: "string" },
            summary: { type: "string", description: "One sentence on what the email says" },
          },
          required: ["index", "watch_id", "summary"],
        },
      },
    },
    required: ["skips", "kept"],
  },
};

// Not unit-tested directly — same as importantEmailClassifier.ts, this repo doesn't mock the
// Anthropic SDK. The prompt builder and parsers above are.
export async function triageRealPersonEmails(
  candidates: TriageCandidate[],
  recentAlerts: string[],
  ownerId: number,
  watches: EmailWatch[] = []
): Promise<TriageResult> {
  if (candidates.length === 0) return { skips: new Map(), gists: new Map() };

  const response = await getClient().messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 2048,
    tools: [TRIAGE_TOOL],
    tool_choice: { type: "tool", name: "triage_emails" },
    messages: [{ role: "user", content: buildTriagePrompt(candidates, recentAlerts, watches) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    TRIAGE_MODEL,
    "real_person_email_triage",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "triage_emails"
  );
  const input = toolUse?.input as { skips?: unknown; kept?: unknown; watch_matches?: unknown } | undefined;
  return {
    skips: parseTriageSkips(input?.skips),
    gists: parseTriageGists(input?.kept),
    watchMatches: parseTriageWatchMatches(input?.watch_matches, watches.map((w) => w.id)),
  };
}
