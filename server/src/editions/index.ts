// The only bridge between general Marlowe code and edition-specific code (see
// docs/superpowers/specs/2026-10-16-business-edition-design.md §1). General code asks this module;
// it never imports server/src/business/ directly.
import type Anthropic from "@anthropic-ai/sdk";
import { getUserEdition, type EditionId } from "../db/store.js";
import { BUSINESS_TOOLS, BUSINESS_TOOL_NAMES, runBusinessTool } from "../business/tools.js";
import { businessPromptSection } from "../business/prompt.js";

export interface Edition {
  id: EditionId;
  brandName: string;
  excludeTools: readonly string[];
  extraTools: Anthropic.Tool[];
  promptSection(ownerId: number): string;
  logsReceipts: boolean;
}

const GENERAL: Edition = {
  id: "general",
  brandName: "Marlowe",
  excludeTools: [],
  extraTools: [],
  promptSection: () => "",
  logsReceipts: false,
};

const BUSINESS: Edition = {
  id: "business",
  brandName: "Marlo for Business",
  excludeTools: [
    "get_news",
    "get_markets",
    "create_trip",
    "link_to_trip",
    "get_trip_contents",
    "list_travel_checkins",
    "count_travel_days",
    // The ledger replaces these: undo_expense hard-deletes, which the books must never do.
    "list_expenses",
    "undo_expense",
  ],
  extraTools: BUSINESS_TOOLS,
  promptSection: businessPromptSection,
  logsReceipts: true,
};

const EDITIONS: Record<EditionId, Edition> = { general: GENERAL, business: BUSINESS };

export function getEdition(ownerId: number): Edition {
  return EDITIONS[getUserEdition(ownerId)];
}

export function isToolExcluded(ownerId: number, name: string): boolean {
  return getEdition(ownerId).excludeTools.includes(name);
}

export function applyEditionTools(ownerId: number, tools: Anthropic.ToolUnion[]): Anthropic.ToolUnion[] {
  const edition = getEdition(ownerId);
  return [
    ...tools.filter((t) => !("name" in t) || !edition.excludeTools.includes(t.name)),
    ...edition.extraTools,
  ];
}

// undefined = not an edition tool; runTool falls through to its own "unknown tool" error.
// Dispatch by tool NAME, not by the caller's edition: a business tool reaching runTool for a
// general user must still hit runBusinessTool's own edition check and be refused.
export async function runEditionTool(
  ownerId: number,
  name: string,
  input: Record<string, unknown>
): Promise<unknown | undefined> {
  if (BUSINESS_TOOL_NAMES.has(name)) return runBusinessTool(ownerId, name, input);
  return undefined;
}
