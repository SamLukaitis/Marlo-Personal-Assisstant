// Rolling summary of everything older than the raw history window ai/assistant.ts sends verbatim
// to the model (MAX_HISTORY_MESSAGES) — folded back into the system prompt by
// buildSystemPrompt's conversationSummary param, so a WhatsApp conversation's effective reach
// isn't hard-capped at the raw window. Regenerated in batches (SUMMARY_BATCH_THRESHOLD) by
// merging the previous summary with each new backlog batch, so it stays compact regardless of how
// long the conversation runs rather than covering a fixed number of extra messages.
import Anthropic from "@anthropic-ai/sdk";
import {
  getConversationSummary,
  saveConversationSummary,
  getWhatsAppBacklogForSummary,
  type WhatsAppMessageRow,
} from "../db/store.js";

// How many raw messages stay directly visible to the model. Mirrors ai/assistant.ts's
// MAX_HISTORY_MESSAGES exactly — duplicated here rather than imported to avoid a circular import
// (ai/assistant.ts reads the summary this file writes, via db/store.ts directly, not via this
// file) — if you change one, change both.
export const RAW_HISTORY_WINDOW = 24;

// Only regenerate the summary once this many messages have fallen out of the raw window since the
// last update — amortizes the summarization LLM call across several turns instead of paying for
// it on every single message.
export const SUMMARY_BATCH_THRESHOLD = 8;

export function buildSummaryPrompt(previousSummary: string | null, batch: WhatsAppMessageRow[]): string {
  const transcript = batch.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
  return [
    previousSummary
      ? `Here is a running summary of an earlier part of this WhatsApp conversation:\n${previousSummary}`
      : "This is the start of the conversation.",
    `Here is the next batch of messages, in order:\n${transcript}`,
    "Write an updated running summary that folds the new batch into the previous one. Keep it " +
      "compact (a few short paragraphs at most) but preserve concrete facts, names, decisions, " +
      "and anything the user might later refer back to (\"you said X\", \"what did I tell you " +
      "about Y\") — specific details matter more than prose style. Reply with only the summary " +
      "text, no preamble.",
  ].join("\n\n");
}

const SUMMARY_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

// Called once per inbound WhatsApp message (fire-and-forget from whatsappRoutes.ts) — cheap to
// call every time, since the no-op path (the common case) is just two indexed SELECTs. Never
// throws: a failed or skipped update degrades to "the model doesn't see that far back yet", not a
// broken reply. Not unit-tested past the no-op path — this repo has no precedent for mocking the
// Anthropic SDK (see importantEmailClassifier.ts); verify the LLM-calling path manually.
export async function maybeUpdateConversationSummary(phone: string): Promise<void> {
  try {
    const existing = getConversationSummary(phone);
    const afterId = existing?.summarizedThroughId ?? 0;
    const batch = getWhatsAppBacklogForSummary(phone, afterId, RAW_HISTORY_WINDOW);
    if (batch.length < SUMMARY_BATCH_THRESHOLD) return;

    const response = await getClient().messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: buildSummaryPrompt(existing?.summary ?? null, batch) }],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return;

    saveConversationSummary(phone, text, batch[batch.length - 1].id);
  } catch (err) {
    console.error("conversationSummary: update failed", err);
  }
}
