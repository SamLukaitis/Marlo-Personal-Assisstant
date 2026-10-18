// Fact lines for the morning briefing (spec §4): last week's money on Mondays, and a nudge when
// anything is waiting for the user's check. The briefing model words them.
import { DateTime } from "luxon";
import { formatPence } from "./categories.js";
import { summariseLedger } from "./ledgerStore.js";

export function businessBriefingFacts(ownerId: number, today: string): string[] {
  const d = DateTime.fromISO(today);
  const facts: string[] = [];
  if (d.weekday === 1) {
    const from = d.minus({ weeks: 1 }).toISODate()!;
    const to = d.minus({ days: 1 }).toISODate()!;
    const s = summariseLedger(ownerId, from, to);
    if (s.incomePence || s.expensesPence) {
      facts.push(
        `Business money last week (${from} to ${to}): ${formatPence(s.incomePence)} in, ${formatPence(s.expensesPence)} out.`
      );
    }
  }
  const { needsReviewCount } = summariseLedger(ownerId, today, today);
  if (needsReviewCount > 0) {
    facts.push(
      `${needsReviewCount} ${needsReviewCount === 1 ? "entry needs" : "entries need"} a quick check in their books — offer to go through them.`
    );
  }
  return facts;
}
