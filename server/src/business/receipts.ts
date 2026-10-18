// Receipt/bill → ledger, for business users (spec §3a/3b). Called after documents.ts has saved the
// document and its derived expense entities; every derived expense (whatever folder the document
// was filed in — a work hotel is an expense too) becomes one ledger entry awaiting review unless
// the supplier's category is already remembered.
import type { ExpenseData } from "../services/entityValidation.js";
import { recordExpense, type Guesser } from "./ledger.js";
import { guessCategory } from "./categorise.js";

export async function receiptToLedger(
  ownerId: number,
  doc: { id: number; source?: string | null },
  derived: { type: string; data: unknown; status: string }[],
  guess: Guesser = guessCategory
): Promise<number> {
  let created = 0;
  const expenses = derived.filter((d) => d.type === "expense");
  for (let i = 0; i < expenses.length; i++) {
    const data = expenses[i].data as ExpenseData;
    if (data.currency !== "GBP") {
      console.warn(`business/receipts: skipping ${data.currency} expense on document ${doc.id} (GBP only)`);
      continue;
    }
    try {
      const res = await recordExpense(
        ownerId,
        {
          amountPence: data.amountPence,
          occurredOn: data.date,
          counterparty: data.vendor,
          source: doc.source === "email" ? "email" : "whatsapp_doc",
          documentId: doc.id,
          sourceRef: `doc:${doc.id}:${i}`,
        },
        guess
      );
      if (res.created) created++;
    } catch (err) {
      console.error(`business/receipts: couldn't add expense ${i} of document ${doc.id} to the ledger`, err);
    }
  }
  return created;
}
