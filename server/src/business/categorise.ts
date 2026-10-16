// One small-model guess at an expense's SA103 box. A guess is only ever a suggestion: ledger.ts
// stores it as needs_review. The API call itself isn't unit-tested (no repo precedent for mocking
// the SDK, same as importantEmailClassifier.ts); the prompt and parser are.
import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";
import { SA103_CATEGORIES, isCategoryKey, formatPence, type CategoryKey } from "./categories.js";
import type { BusinessUse } from "./ledgerStore.js";
import { getBusinessDescription } from "./profile.js";

export interface CategoriseItem {
  counterparty: string;
  description?: string | null;
  amountPence: number;
}

export interface CategoryGuess {
  category: CategoryKey;
  businessUse: BusinessUse;
}

const MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const TOOL: Anthropic.Tool = {
  name: "categorise_expense",
  description: "Report the best HMRC expense category for this purchase and whether it is likely business or personal.",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", enum: SA103_CATEGORIES.map((c) => c.key) },
      business_use: { type: "string", enum: ["business", "personal", "unsure"] },
    },
    required: ["category", "business_use"],
  },
};

export function buildCategorisePrompt(item: CategoriseItem, businessDescription: string | null): string {
  return [
    `A UK sole trader${businessDescription ? ` (${businessDescription})` : ""} spent ${formatPence(item.amountPence)} at "${
      item.counterparty
    }"${item.description ? ` — ${item.description}` : ""}.`,
    "Pick the single best HMRC self-employment expense category:",
    ...SA103_CATEGORIES.map((c) => `- ${c.key}: ${c.label} — ${c.hints}`),
    "Say business_use=personal for obviously personal spending (groceries, restaurants, clothes, entertainment), unsure if it could be either.",
  ].join("\n");
}

export function parseCategoryGuess(input: unknown): CategoryGuess | null {
  const i = input as { category?: unknown; business_use?: unknown } | undefined;
  if (!i || !isCategoryKey(i.category)) return null;
  if (i.business_use !== "business" && i.business_use !== "personal" && i.business_use !== "unsure") return null;
  return { category: i.category, businessUse: i.business_use };
}

export async function guessCategory(ownerId: number, item: CategoriseItem): Promise<CategoryGuess | null> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 200,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: buildCategorisePrompt(item, getBusinessDescription(ownerId)) }],
  });
  recordApiUsage(
    ownerId,
    "background",
    MODEL,
    "business_categoriser",
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
    response.usage?.cache_read_input_tokens ?? 0,
    response.usage?.cache_creation_input_tokens ?? 0
  );
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return parseCategoryGuess(toolUse?.input);
}
