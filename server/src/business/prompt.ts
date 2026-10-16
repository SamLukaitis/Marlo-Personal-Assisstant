// The business edition's section of the assistant system prompt (spec §4): who the user is, how to
// talk about money, and what's waiting for their check.
import { formatPence, categoryLabel } from "./categories.js";
import { listLedgerEntries } from "./ledgerStore.js";
import { getBusinessDescription } from "./profile.js";

export function businessPromptSection(ownerId: number): string {
  const description = getBusinessDescription(ownerId);
  const review = listLedgerEntries(ownerId, { status: "needs_review", limit: 5 });
  const anyEntries = review.length > 0 || listLedgerEntries(ownerId, { limit: 1 }).length > 0;
  return [
    "BUSINESS EDITION: this user is a UK sole trader and you are their admin assistant for the business — receipts, bills, payments, email and diary.",
    description
      ? `Their business: ${description}.`
      : "You don't know what their business does yet. Early in the conversation, ask in one short line, then call set_business_profile.",
    "Receipts and bills they send are added to their books automatically. Money they mention in chat goes in with log_expense / log_income. Talk in plain English, no accountancy jargon unless they use it.",
    "Anything about tax is an estimate, never advice. For judgement calls (use of home, mixed business/personal use, capital items) suggest they check with an accountant. Client entertainment isn't an allowable expense — log it as personal.",
    anyEntries ? "" : "Their books are empty: invite them to send a photo of any receipt to see how it works.",
    review.length
      ? `Waiting for the user's check (ask about the newest one or two when there's a natural moment, using ask_user_choice buttons, then confirm_ledger_entry):\n${review
          .map(
            (e) =>
              `- #${e.id} ${e.direction === "in" ? "from" : "to"} ${e.counterparty ?? "unknown"} ${formatPence(e.amountPence)} on ${
                e.occurredOn
              }, guessed ${categoryLabel(e.category)} / ${e.businessUse}`
          )
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
