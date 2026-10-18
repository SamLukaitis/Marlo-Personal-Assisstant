// Assistant tools for the business edition. Reached only via editions/index.ts. Amounts cross the
// model boundary in pounds (what people say) and are stored in pence.
import type Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { getUserEdition } from "../db/store.js";
import { SA103_CATEGORIES, isCategoryKey, formatPence, categoryLabel } from "./categories.js";
import { recordExpense, recordIncome, confirmEntry } from "./ledger.js";
import {
  listLedgerEntries,
  softDeleteLedgerEntry,
  updateLedgerEntry,
  summariseLedger,
  type BusinessUse,
  type LedgerEntry,
} from "./ledgerStore.js";
import { setBusinessDescription } from "./profile.js";
import { taxYearFor } from "./taxYear.js";

const CATEGORY_ENUM = SA103_CATEGORIES.map((c) => c.key);
const PERIODS = ["this_week", "last_week", "this_month", "last_month", "tax_year", "last_tax_year"] as const;
type Period = (typeof PERIODS)[number];

export const BUSINESS_TOOLS: Anthropic.Tool[] = [
  {
    name: "set_business_profile",
    description:
      "Save a one-line description of what the user's business does (e.g. 'plumber in Leeds', 'wedding photographer'). Call it as soon as they tell you; it improves expense categorising.",
    input_schema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
  },
  {
    name: "log_expense",
    description:
      "Add money the user spent to their books when they tell you about it in chat (receipts they send are added automatically — don't re-add those). amount is in pounds. Set category and business_use only if the user said or it's unambiguous; otherwise leave them out and the entry waits for review.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Pounds, e.g. 32.50" },
        date: { type: "string", description: "YYYY-MM-DD; call get_current_time first for relative days" },
        paid_to: { type: "string" },
        description: { type: "string" },
        category: { type: "string", enum: CATEGORY_ENUM },
        business_use: { type: "string", enum: ["business", "personal"] },
      },
      required: ["amount", "date", "paid_to"],
    },
  },
  {
    name: "log_income",
    description: "Add money the user was paid to their books when they tell you in chat ('Dave paid me £450'). amount is in pounds.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        date: { type: "string", description: "YYYY-MM-DD" },
        from: { type: "string", description: "Who paid" },
        description: { type: "string" },
      },
      required: ["amount", "date", "from"],
    },
  },
  {
    name: "list_ledger",
    description: "List entries in the user's books, newest first. Use status=needs_review to find what's waiting for the user's check.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        direction: { type: "string", enum: ["in", "out"] },
        status: { type: "string", enum: ["confirmed", "needs_review"] },
        category: { type: "string", enum: CATEGORY_ENUM },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "confirm_ledger_entry",
    description:
      "Record the user's answer to a review question about an entry: business or personal, and optionally a different category. Their choice is remembered for that supplier so they aren't asked again. Ask with ask_user_choice buttons, not prose.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "number" },
        business_use: { type: "string", enum: ["business", "personal"] },
        category: { type: "string", enum: CATEGORY_ENUM },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "update_ledger_entry",
    description: "Correct an entry's amount (pounds), date, who it was with, or description. Every change is kept in the entry's history.",
    input_schema: {
      type: "object",
      properties: {
        entry_id: { type: "number" },
        amount: { type: "number" },
        date: { type: "string" },
        counterparty: { type: "string" },
        description: { type: "string" },
      },
      required: ["entry_id"],
    },
  },
  {
    name: "remove_ledger_entry",
    description:
      "Take an entry out of the books (wrong, duplicate, not real). It's kept in history, not erased. Confirm with ask_user_choice first unless the user was explicit.",
    input_schema: { type: "object", properties: { entry_id: { type: "number" } }, required: ["entry_id"] },
  },
  {
    name: "get_money_summary",
    description:
      "Totals of business money in and out for a period, by HMRC category, plus how many entries need review. Personal and unreviewed entries are not counted.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: [...PERIODS] },
        today: { type: "string", description: "Leave out." },
      },
      required: ["period"],
    },
  },
];

export const BUSINESS_TOOL_NAMES: ReadonlySet<string> = new Set(BUSINESS_TOOLS.map((t) => t.name));

export function periodRange(period: Period, today: string): { from: string; to: string } {
  const d = DateTime.fromISO(today);
  switch (period) {
    case "this_week":
      return { from: d.startOf("week").toISODate()!, to: today };
    case "last_week": {
      const s = d.startOf("week").minus({ weeks: 1 });
      return { from: s.toISODate()!, to: s.endOf("week").toISODate()! };
    }
    case "this_month":
      return { from: d.startOf("month").toISODate()!, to: today };
    case "last_month": {
      const s = d.startOf("month").minus({ months: 1 });
      return { from: s.toISODate()!, to: s.endOf("month").toISODate()! };
    }
    case "tax_year":
      return { from: taxYearFor(today).start, to: today };
    case "last_tax_year": {
      const prev = taxYearFor(DateTime.fromISO(taxYearFor(today).start).minus({ days: 1 }).toISODate()!);
      return { from: prev.start, to: prev.end };
    }
  }
}

function poundsToPence(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) throw new Error("amount must be a positive number of pounds");
  return Math.round(x * 100);
}

function present(e: LedgerEntry) {
  return {
    id: e.id,
    direction: e.direction,
    amount: formatPence(e.amountPence),
    date: e.occurredOn,
    counterparty: e.counterparty,
    description: e.description,
    category: e.category ? categoryLabel(e.category) : null,
    business_use: e.businessUse,
    status: e.status,
    source: e.source,
  };
}

const todayISO = () => DateTime.now().toISODate()!;

export async function runBusinessTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (getUserEdition(ownerId) !== "business") return { error: `${name} is only available on the business edition.` };
  try {
    switch (name) {
      case "set_business_profile":
        setBusinessDescription(ownerId, String(input.description ?? ""));
        return { ok: true };
      case "log_expense": {
        const res = await recordExpense(
          ownerId,
          {
            amountPence: poundsToPence(input.amount),
            occurredOn: String(input.date),
            counterparty: String(input.paid_to),
            description: (input.description as string | undefined) ?? null,
            source: "chat",
            category: isCategoryKey(input.category) ? input.category : undefined,
            businessUse: input.business_use as BusinessUse | undefined,
          },
          async () => null // chat entries never call the model: if the user didn't say, ask them
        );
        return { ok: true, entry: present(res.entry) };
      }
      case "log_income": {
        const res = recordIncome(ownerId, {
          amountPence: poundsToPence(input.amount),
          occurredOn: String(input.date),
          counterparty: String(input.from),
          description: (input.description as string | undefined) ?? null,
          source: "chat",
        });
        return { ok: true, entry: present(res.entry) };
      }
      case "list_ledger": {
        const range = input.period ? periodRange(input.period as Period, todayISO()) : {};
        return listLedgerEntries(ownerId, {
          ...range,
          direction: input.direction as "in" | "out" | undefined,
          status: input.status as "confirmed" | "needs_review" | undefined,
          category: input.category as string | undefined,
          limit: (input.limit as number | undefined) ?? 30,
        }).map(present);
      }
      case "confirm_ledger_entry": {
        const e = confirmEntry(ownerId, Number(input.entry_id), {
          businessUse: input.business_use as BusinessUse | undefined,
          category: isCategoryKey(input.category) ? input.category : undefined,
        });
        return e ? { ok: true, entry: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "update_ledger_entry": {
        const e = updateLedgerEntry(
          ownerId,
          Number(input.entry_id),
          {
            amountPence: input.amount === undefined ? undefined : poundsToPence(input.amount),
            occurredOn: input.date as string | undefined,
            counterparty: input.counterparty as string | undefined,
            description: input.description as string | undefined,
          },
          "user"
        );
        return e ? { ok: true, entry: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "remove_ledger_entry": {
        const e = softDeleteLedgerEntry(ownerId, Number(input.entry_id), "user");
        return e ? { ok: true, removed: present(e) } : { error: `No entry ${input.entry_id}.` };
      }
      case "get_money_summary": {
        const { from, to } = periodRange(input.period as Period, (input.today as string | undefined) ?? todayISO());
        const s = summariseLedger(ownerId, from, to);
        return {
          from,
          to,
          income: formatPence(s.incomePence),
          expenses: formatPence(s.expensesPence),
          profit: formatPence(s.incomePence - s.expensesPence),
          by_category: Object.fromEntries(Object.entries(s.byCategory).map(([k, v]) => [categoryLabel(k), formatPence(v)])),
          needs_review: s.needsReviewCount,
        };
      }
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: (err as Error).message };
  }
}
