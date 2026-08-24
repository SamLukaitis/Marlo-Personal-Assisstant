import type Anthropic from "@anthropic-ai/sdk";
import { validateTravelMovement, type TravelMovement, type ValidationResult } from "./travelValidation.js";
import { validateExpense, validateBooking, type ExpenseData, type BookingData } from "./entityValidation.js";

// The "define a type once" registry (docs/entities-and-links-guide.md §4): each entity type
// declares its own validator and the read tools it exposes to the assistant, in one place, so the
// generic entities/links tables + store functions handle everything else. Foundation only for
// now — nothing calls getEntityTypeDef yet. travel_checkin's actual assistant tools
// (list_travel_checkins, count_travel_days in ai/assistant.ts) still go through the older
// ToolKey/CONDITIONAL_TOOLS gate unchanged; this registry is what a genuinely new type (expense,
// Phase C) plugs into first.
export interface EntityTypeDef<T = unknown> {
  type: string;
  validate(data: unknown, ctx: { uploadedAt: Date }): ValidationResult;
  tools: Anthropic.Tool[];
}

const registry = new Map<string, EntityTypeDef>();

export function registerEntityType<T>(def: EntityTypeDef<T>): void {
  registry.set(def.type, def as EntityTypeDef);
}

export function getEntityTypeDef(type: string): EntityTypeDef | undefined {
  return registry.get(type);
}

// validateTravelMovement already has the exact ValidationResult shape this registry expects
// (guide §1) — wrapping it here is a straight delegation, not a rewrite. Known wart: this
// validator checks the extracted *movement* (departure→arrival), not the stored single-point
// checkin shape — the newer types below validate exactly what's stored.
registerEntityType<TravelMovement>({
  type: "travel_checkin",
  validate: (data, ctx) => validateTravelMovement(data as TravelMovement, ctx.uploadedAt),
  tools: [],
});

// The assistant read tools for these live in ai/assistant.ts's ALWAYS_ON_TOOLS spine (its
// existing single source of tool definitions); tools: [] here until the registry becomes the
// thing buildToolsForOwner actually reads from.
registerEntityType<ExpenseData>({
  type: "expense",
  validate: (data, ctx) => validateExpense(data, ctx),
  tools: [],
});

registerEntityType<BookingData>({
  type: "booking",
  validate: (data, ctx) => validateBooking(data, ctx),
  tools: [],
});
