import { listAccounts, getAccount, type AccountRow } from "../db/store.js";
import * as g from "../providers/google.js";
import * as ms from "../providers/microsoft.js";
import type { UnifiedMessage, CalendarEvent, FileHit, DraftResult } from "../providers/types.js";

function settle<T>(results: PromiseSettledResult<T[]>[]): T[] {
  return results.flatMap((r) => {
    if (r.status === "rejected") {
      console.error("hub: provider call failed:", r.reason);
      return [];
    }
    return r.value;
  });
}

function requireAccount(accountId: number): AccountRow {
  const account = getAccount(accountId);
  if (!account) throw new Error(`No connected account with id ${accountId}`);
  return account;
}

export async function hubListMessages(opts: {
  query?: string;
  limit?: number;
  accountId?: number;
}): Promise<UnifiedMessage[]> {
  const accounts = opts.accountId ? [requireAccount(opts.accountId)] : listAccounts();
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.provider === "google"
        ? g.googleListMessages(a, opts)
        : ms.microsoftListMessages(a, opts)
    )
  );
  return settle(results).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
}

export async function hubGetMessage(
  accountId: number,
  messageId: string
): Promise<UnifiedMessage | null> {
  const account = requireAccount(accountId);
  return account.provider === "google"
    ? g.googleGetMessage(account, messageId)
    : ms.microsoftGetMessage(account, messageId);
}

export async function hubListEvents(days = 7): Promise<CalendarEvent[]> {
  const results = await Promise.allSettled(
    listAccounts().map((a) =>
      a.provider === "google" ? g.googleListEvents(a, days) : ms.microsoftListEvents(a, days)
    )
  );
  return settle(results).sort((a, b) => (a.start > b.start ? 1 : -1));
}

export async function hubSearchFiles(query: string): Promise<FileHit[]> {
  // Drive only for now; OneDrive search can be added in the Microsoft provider later.
  const results = await Promise.allSettled(
    listAccounts("google").map((a) => g.googleSearchFiles(a, query))
  );
  return settle(results).sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

export async function hubCreateDraft(
  accountId: number,
  to: string,
  subject: string,
  body: string
): Promise<DraftResult> {
  const account = requireAccount(accountId);
  return account.provider === "google"
    ? g.googleCreateDraft(account, to, subject, body)
    : ms.microsoftCreateDraft(account, to, subject, body);
}
