// Payment-received mail → income awaiting review (spec §3c). Deliberately deterministic: these
// senders' formats are stable, a false positive only ever creates a needs_review row the user can
// dismiss, and it costs nothing per email. Never sends anything; the briefing and the assistant's
// prompt surface the review count.
import { recordIncome } from "./ledger.js";

const INCOME = [
  /\bpayout\b/i,
  /you(?:'ve| have) (?:got|received) (?:money|a payment)/i,
  /\bsent you\b/i,
  /payment received/i,
  /remittance advice/i,
  /\binvoice\b.*\b(?:has been|was) paid\b|\bpaid\b.*\binvoice\b/i,
];
const NOT_INCOME = /\brefund|receipt for your payment|your payment to|\byou paid\b|\byou sent\b|payment failed|\bdeclined/i;
const AMOUNT = /£\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+(?:\.\d{2})?)/;
const PAYER = /([A-Z][\w'&.-]*(?: [A-Z][\w'&.-]*){0,3}) (?:sent you|paid)\b/;

export interface DetectedIncome {
  amountPence: number;
  counterparty: string;
  occurredOn: string;
}

function senderName(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return (named?.[1] ?? from.split("@")[0]).trim();
}

export function detectIncome(m: { from: string; subject: string; snippet: string; receivedAt: string }): DetectedIncome | null {
  const text = `${m.subject}\n${m.snippet}`;
  if (NOT_INCOME.test(text) || !INCOME.some((r) => r.test(text))) return null;
  const amount = AMOUNT.exec(m.subject) ?? AMOUNT.exec(m.snippet);
  if (!amount) return null;
  const amountPence = Math.round(Number(amount[1].replace(/,/g, "")) * 100);
  if (!Number.isFinite(amountPence) || amountPence <= 0) return null;
  // No usable date means no tax year to put it in; skip it rather than throw and lose the batch.
  const received = new Date(m.receivedAt);
  if (Number.isNaN(received.getTime())) return null;
  return {
    amountPence,
    counterparty: PAYER.exec(m.snippet)?.[1] ?? senderName(m.from),
    occurredOn: received.toISOString().slice(0, 10),
  };
}

export function incomeFromMail(
  ownerId: number,
  messages: { accountId: number; id: string; from: string; subject: string; snippet: string; receivedAt: string }[]
): number {
  let created = 0;
  for (const m of messages) {
    const found = detectIncome(m);
    if (!found) continue;
    try {
      const res = recordIncome(ownerId, {
        ...found,
        description: m.subject,
        source: "email",
        sourceRef: `email:${m.accountId}:${m.id}`,
      });
      if (res.created) created++;
    } catch (err) {
      console.error(`business/incomeDetector: couldn't record income from message ${m.id}`, err);
    }
  }
  return created;
}
