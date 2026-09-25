// Last check before a "X emailed you" alert goes out (alerts.ts). The provider signals in hub.ts's
// isAutomatedMail catch most bulk mail, but not all of it (a provider that sends no bulk signal, a
// marketer with an ordinary-looking From), and they can't see that a venue's own confirmation email
// repeats the booking-site confirmation the user was already told about. Both are judgement calls,
// so one small model call makes them, biased hard toward alerting — a missed person is worse than
// an extra ping.

import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { tidySnippet } from "./htmlToText.js";

export interface TriageCandidate {
  index: number;
  from: string;
  subject: string;
  snippet: string;
}

export type TriageSkipReason = "not_personal" | "duplicate";

export function buildTriagePrompt(candidates: TriageCandidate[], recentAlerts: string[]): string {
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
    "earlier alert, must NOT be skipped. When unsure, do not skip. Omit indices that should alert.\n\n" +
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

const TRIAGE_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const TRIAGE_TOOL: Anthropic.Tool = {
  name: "skip_emails",
  description: "Report which of the numbered emails should NOT trigger an alert. Omit every other index.",
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
    },
    required: ["skips"],
  },
};

// Not unit-tested directly — same as importantEmailClassifier.ts, this repo doesn't mock the
// Anthropic SDK. The prompt builder and parser above are.
export async function triageRealPersonEmails(
  candidates: TriageCandidate[],
  recentAlerts: string[],
  ownerId: number
): Promise<Map<number, TriageSkipReason>> {
  if (candidates.length === 0) return new Map();

  const response = await getClient().messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    tools: [TRIAGE_TOOL],
    tool_choice: { type: "tool", name: "skip_emails" },
    messages: [{ role: "user", content: buildTriagePrompt(candidates, recentAlerts) }],
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
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "skip_emails"
  );
  return parseTriageSkips((toolUse?.input as { skips?: unknown } | undefined)?.skips);
}
