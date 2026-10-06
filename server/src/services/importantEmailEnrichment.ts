// One small model call per flagged email (never per email): reads the full body so the attention
// gate can schedule reminders from real dates, times, references and amounts rather than a
// truncated preview. See docs/superpowers/specs/2026-09-28-attention-gate-design.md.
import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { tidySnippet } from "./htmlToText.js";

export interface EnrichmentInput {
  category: string;
  subject: string;
  from: string;
  body: string;
  receivedAt: string;
  zone: string | null;
}

export interface EnrichmentResult {
  summary: string;
  kind?: "flight" | "hotel" | "restaurant" | "other";
  eventStart?: string;
  dueDate?: string;
  reference?: string;
  flightNumber?: string;
  merchant?: string;
  amount?: string;
  needsAction?: boolean;
}

const MAX_BODY_CHARS = 6_000;
const KINDS = ["flight", "hotel", "restaurant", "other"] as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/;

export function buildEnrichmentPrompt(input: EnrichmentInput): string {
  const body = tidySnippet(input.body, MAX_BODY_CHARS);
  return (
    `This email was flagged as "${input.category}". The user's timezone is ${input.zone ?? "unknown"}; ` +
    `the email arrived ${input.receivedAt}.\n\n` +
    "Extract the concrete facts. summary: one sentence addressed to the user, starting with 'Your' " +
    "where it fits, with every specific (name, flight/reference number, amount, date, time, place) in " +
    "WhatsApp bold (*text*). event_start: when the booked thing starts — 'YYYY-MM-DDTHH:MM:SS+HH:MM' " +
    "if the email states a time (use the offset of the place it happens), else 'YYYY-MM-DD'. due_date: " +
    "'YYYY-MM-DD' a bill is due or a subscription charges. kind: flight, hotel, restaurant or other, " +
    "for bookings only. needs_action: true only if the user must do something themselves. Leave out " +
    "anything the email doesn't state — never guess a date.\n\n" +
    `From: ${input.from}\nSubject: ${input.subject}\n\n${body}`
  );
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseEnrichment(raw: unknown): EnrichmentResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const summary = str(r.summary);
  if (!summary) return null;
  const result: EnrichmentResult = { summary };
  const kind = str(r.kind);
  if (kind && (KINDS as readonly string[]).includes(kind)) result.kind = kind as EnrichmentResult["kind"];
  const eventStart = str(r.event_start);
  if (eventStart && (DATE_ONLY.test(eventStart) || DATE_TIME.test(eventStart))) result.eventStart = eventStart;
  const dueDate = str(r.due_date);
  if (dueDate && DATE_ONLY.test(dueDate)) result.dueDate = dueDate;
  const reference = str(r.reference);
  if (reference) result.reference = reference;
  const flightNumber = str(r.flight_number);
  if (flightNumber) result.flightNumber = flightNumber;
  const merchant = str(r.merchant);
  if (merchant) result.merchant = merchant;
  const amount = str(r.amount);
  if (amount) result.amount = amount;
  if (typeof r.needs_action === "boolean") result.needsAction = r.needs_action;
  return result;
}

const ENRICH_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const ENRICH_TOOL: Anthropic.Tool = {
  name: "record_email_facts",
  description: "Record the concrete facts stated in the email. Omit any field the email doesn't state.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      kind: { type: "string", enum: [...KINDS] },
      event_start: { type: "string" },
      due_date: { type: "string" },
      reference: { type: "string" },
      flight_number: { type: "string" },
      merchant: { type: "string" },
      amount: { type: "string" },
      needs_action: { type: "boolean" },
    },
    required: ["summary"],
  },
};

// Not unit-tested directly — same as importantEmailClassifier.ts, this repo doesn't mock the
// Anthropic SDK. The prompt builder and parser above are.
export async function enrichImportantEmail(input: EnrichmentInput, ownerId: number): Promise<EnrichmentResult | null> {
  const response = await getClient().messages.create({
    model: ENRICH_MODEL,
    max_tokens: 1024,
    tools: [ENRICH_TOOL],
    tool_choice: { type: "tool", name: "record_email_facts" },
    messages: [{ role: "user", content: buildEnrichmentPrompt(input) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    ENRICH_MODEL,
    "important_email_enrichment",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );
  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_email_facts"
  );
  return parseEnrichment(toolUse?.input);
}
