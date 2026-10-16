// The rules for what goes into the books (spec §3). Only the user's own word, or a choice they
// made before for the same counterparty, produces a confirmed entry; a model guess is pre-filled
// but always waits for review.
import type { CategoryKey } from "./categories.js";
import { guessCategory, type CategoriseItem, type CategoryGuess } from "./categorise.js";
import {
  insertLedgerEntry,
  getLedgerEntry,
  updateLedgerEntry,
  getCounterpartyChoice,
  rememberCounterpartyChoice,
  type BusinessUse,
  type LedgerEntry,
  type LedgerSource,
} from "./ledgerStore.js";

export type Guesser = (ownerId: number, item: CategoriseItem) => Promise<CategoryGuess | null>;

export async function recordExpense(
  ownerId: number,
  input: {
    amountPence: number;
    occurredOn: string;
    counterparty: string;
    description?: string | null;
    source: LedgerSource;
    documentId?: number | null;
    sourceRef?: string | null;
    category?: CategoryKey;
    businessUse?: BusinessUse;
  },
  guess: Guesser = guessCategory
): Promise<{ entry: LedgerEntry; created: boolean }> {
  const common = {
    direction: "out" as const,
    amountPence: input.amountPence,
    occurredOn: input.occurredOn,
    counterparty: input.counterparty,
    description: input.description ?? null,
    source: input.source,
    documentId: input.documentId ?? null,
    sourceRef: input.sourceRef ?? null,
  };

  // The user said it themselves: personal needs no category; business needs one.
  if (input.businessUse && input.businessUse !== "unsure" && (input.category || input.businessUse === "personal")) {
    rememberCounterpartyChoice(ownerId, input.counterparty, input.category ?? null, input.businessUse);
    return insertLedgerEntry(ownerId, {
      ...common,
      category: input.category ?? null,
      businessUse: input.businessUse,
      status: "confirmed",
    });
  }

  const remembered = getCounterpartyChoice(ownerId, input.counterparty);
  if (remembered && remembered.businessUse !== "unsure") {
    return insertLedgerEntry(ownerId, {
      ...common,
      category: remembered.category,
      businessUse: remembered.businessUse,
      status: "confirmed",
    });
  }

  let guessed: CategoryGuess | null = null;
  try {
    guessed = await guess(ownerId, {
      counterparty: input.counterparty,
      description: input.description,
      amountPence: input.amountPence,
    });
  } catch (err) {
    console.error("business/ledger: category guess failed; recording for review without one", err);
  }
  return insertLedgerEntry(ownerId, {
    ...common,
    category: input.category ?? guessed?.category ?? null,
    businessUse: input.businessUse ?? guessed?.businessUse ?? "unsure",
    status: "needs_review",
  });
}

export function recordIncome(
  ownerId: number,
  input: {
    amountPence: number;
    occurredOn: string;
    counterparty: string;
    description?: string | null;
    source: LedgerSource;
    sourceRef?: string | null;
  }
): { entry: LedgerEntry; created: boolean } {
  return insertLedgerEntry(ownerId, {
    direction: "in",
    amountPence: input.amountPence,
    occurredOn: input.occurredOn,
    counterparty: input.counterparty,
    description: input.description ?? null,
    businessUse: "business",
    // Only what the user told us is confirmed; anything spotted (email, bank) waits for a yes.
    status: input.source === "chat" ? "confirmed" : "needs_review",
    source: input.source,
    sourceRef: input.sourceRef ?? null,
  });
}

export function confirmEntry(
  ownerId: number,
  id: number,
  choice: { category?: CategoryKey; businessUse?: BusinessUse }
): LedgerEntry | null {
  const before = getLedgerEntry(ownerId, id);
  if (!before || before.deletedAt) return null;
  const businessUse = choice.businessUse ?? before.businessUse;
  if (businessUse === "unsure") throw new Error("Need to know if this is business or personal before confirming it.");
  const category = choice.category ?? before.category;
  const after = updateLedgerEntry(ownerId, id, { category, businessUse, status: "confirmed" }, "user");
  if (after?.direction === "out" && after.counterparty) {
    rememberCounterpartyChoice(ownerId, after.counterparty, after.category, after.businessUse);
  }
  return after;
}
