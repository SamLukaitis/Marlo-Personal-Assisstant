// Classifies automated/transactional mail into a fixed category set that neither
// checkForNewImportantMessages (alerts.ts, real people only) nor
// checkNewEmailsAgainstRecentDocuments (reconciliation.ts, requires an already-saved document)
// can catch. See docs/superpowers/specs/2026-08-26-important-email-alerts-design.md.

import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";

export const IMPORTANT_EMAIL_CATEGORIES = [
  "flight_change",
  "reservation_confirmed",
  "invoice_due",
  "government_mail",
  "delivery_notification",
  "security_alert",
  "subscription_renewal",
  "refund_dispute",
] as const;

export type ImportantEmailCategory = (typeof IMPORTANT_EMAIL_CATEGORIES)[number];

export const CATEGORY_INFO: Record<
  ImportantEmailCategory,
  { emoji: string; label: string; description: string }
> = {
  flight_change: {
    emoji: "✈️",
    label: "Flight change",
    description: "A flight or reservation change, delay, or cancellation notice.",
  },
  reservation_confirmed: {
    emoji: "✅",
    label: "Reservation confirmed",
    description: "A new reservation confirmation (flight, hotel, car rental, restaurant, etc.).",
  },
  invoice_due: {
    emoji: "💳",
    label: "Invoice/payment due",
    description:
      "A bill addressed TO the user asking them to pay someone else — a vendor invoice, a " +
      "utility bill, a subscription charge, etc. Does NOT include a notification/copy/receipt " +
      "for an invoice the user's own business issued or sent to one of its own clients or " +
      "customers (e.g. an invoicing tool confirming 'your invoice to [client] was sent/paid/" +
      "viewed') — that is the user being paid, not owing payment, and must never match this " +
      "category.",
  },
  government_mail: {
    emoji: "🏛️",
    label: "Government correspondence",
    description: "Correspondence from a government agency (tax, benefits, visa, license, etc.).",
  },
  delivery_notification: {
    emoji: "📦",
    label: "Delivery notice",
    description: "A package delivery notice: out for delivery, delayed, or a delivery exception.",
  },
  security_alert: {
    emoji: "🔐",
    label: "Security alert",
    description: "A security or account alert: new sign-in, password changed, suspicious activity.",
  },
  subscription_renewal: {
    emoji: "🔁",
    label: "Subscription renewal",
    description: "An upcoming subscription auto-renewal charge, or notice of a price increase.",
  },
  refund_dispute: {
    emoji: "💰",
    label: "Refund/dispute update",
    description: "A status update on a refund, chargeback, or dispute already in progress.",
  },
};

export interface ClassifyCandidate {
  index: number;
  subject: string;
  snippet: string;
}

// Pure — builds the prompt text from candidates and the fixed category list. Split out from
// classifyImportantEmails so it's unit-testable without an API call.
export function buildClassifyPrompt(candidates: ClassifyCandidate[]): string {
  const categoryList = IMPORTANT_EMAIL_CATEGORIES.map(
    (c) => `- ${c}: ${CATEGORY_INFO[c].description}`
  ).join("\n");
  const emailList = candidates
    .map((c) => `[${c.index}] Subject: ${c.subject}\nSnippet: ${c.snippet}`)
    .join("\n\n");
  return (
    `Categories:\n${categoryList}\n\n` +
    "For each numbered email below, decide whether it clearly falls into exactly one of these " +
    "categories. Only include emails that are a clear, confident match — skip anything " +
    "ambiguous, promotional, or a generic automated notice that isn't one of these categories " +
    "(newsletters, marketing, app notifications with no action needed). Omit indices that don't " +
    "match. For each match, also write a one-sentence plain-English summary of what the email " +
    "actually says (the concrete fact — what changed, what's due, what to expect) in your own " +
    "words. This summary becomes the whole WhatsApp message the user reads, so: write it as a " +
    "complete, natural sentence addressed directly to the user (start with 'your' where it fits, " +
    "e.g. 'Your flight to Paris was delayed to 6:45pm.' or 'Your Hilton reservation is confirmed " +
    "for 12–15 June.'), and wrap every concrete specific — vendor/airline/hotel name, flight or " +
    "confirmation number, amount, date, or place — in WhatsApp bold (*text*, single asterisks on " +
    "each side) so it stands out at a glance. Never copy the snippet verbatim — it may be " +
    "truncated mid-sentence or contain raw HTML entities. Also set needs_action: true only when " +
    "the user must do something themselves (pay, reply, reschedule, collect a parcel, respond by a " +
    "deadline); false for confirmations, receipts and routine status updates." +
    `\n\n${emailList}`
  );
}

export interface ClassifyMatch {
  category: ImportantEmailCategory;
  // One-sentence plain-English summary the model wrote from the subject/snippet, replacing the
  // raw Gmail/Outlook snippet (HTML-entity-encoded, truncated mid-sentence) in the WhatsApp alert.
  summary: string;
  // True when the user must do something: pay, reply, reschedule, collect, respond by a deadline.
  // Feeds the attention gate's tiering (attentionRules.ts).
  needsAction: boolean;
}

// Pure — turns the tool call's raw `matches` input into a validated Map, dropping anything
// malformed rather than throwing (an LLM tool call is not a type-checked boundary). An entry
// with no usable summary still counts as a category match — the caller falls back to the
// snippet rather than losing it entirely.
export function parseClassifyMatches(matches: unknown): Map<number, ClassifyMatch> {
  const result = new Map<number, ClassifyMatch>();
  if (!Array.isArray(matches)) return result;
  for (const entry of matches) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { index?: unknown }).index === "number" &&
      (IMPORTANT_EMAIL_CATEGORIES as readonly string[]).includes(
        (entry as { category?: unknown }).category as string
      )
    ) {
      const summary = (entry as { summary?: unknown }).summary;
      result.set((entry as { index: number }).index, {
        category: (entry as { category: ImportantEmailCategory }).category,
        summary: typeof summary === "string" ? summary.trim() : "",
        needsAction: (entry as { needs_action?: unknown }).needs_action === true,
      });
    }
  }
  return result;
}

const CLASSIFY_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_messages",
  description:
    "Report which of the numbered emails above (if any) match one of the given categories. " +
    "Omit any index that isn't a clear, confident match.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "The email's number from the list above" },
            category: { type: "string", enum: [...IMPORTANT_EMAIL_CATEGORIES] },
            summary: {
              type: "string",
              description:
                "One plain-English sentence summarizing what the email actually says — your own " +
                "words, not the raw snippet.",
            },
            needs_action: { type: "boolean", description: "Whether the user must do something themselves." },
          },
          required: ["index", "category", "summary", "needs_action"],
        },
      },
    },
    required: ["matches"],
  },
};

// Not unit-tested directly — this repo has no precedent for mocking the Anthropic SDK, same as
// documents.ts's extraction call. Verified manually (see plan Task 7).
export async function classifyImportantEmails(
  candidates: ClassifyCandidate[],
  ownerId: number
): Promise<Map<number, ClassifyMatch>> {
  if (candidates.length === 0) return new Map();

  const response = await getClient().messages.create({
    model: CLASSIFY_MODEL,
    max_tokens: 4096,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_messages" },
    messages: [{ role: "user", content: buildClassifyPrompt(candidates) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    CLASSIFY_MODEL,
    "email_importance_classifier",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );

  if (response.stop_reason === "max_tokens") {
    throw new Error("classification response was truncated (max_tokens)");
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "classify_messages"
  );
  return parseClassifyMatches((toolUse?.input as { matches?: unknown } | undefined)?.matches);
}
