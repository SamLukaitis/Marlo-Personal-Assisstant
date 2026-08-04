import {
  listAccounts,
  getAccount,
  markAccountAuthBroken,
  markAccountAuthHealthy,
  type AccountRow,
} from "../db/store.js";
import * as g from "../providers/google.js";
import * as ms from "../providers/microsoft.js";
import * as local from "../providers/local.js";
import type {
  UnifiedMessage,
  CalendarEvent,
  FileHit,
  DraftResult,
  ChatThread,
  ContactHit,
  EventInput,
} from "../providers/types.js";

// Both providers throw differently (Google's gaxios errors carry structured
// response.status/data, Microsoft's are plain Errors with the status baked into the message)
// so this checks every shape rather than assuming one. False positives just show an
// unnecessary "reconnect" prompt; false negatives just fall back to the old silent-empty
// behavior — neither is dangerous, so a lenient heuristic is the right tradeoff here.
function isAuthError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; code?: unknown; status?: unknown; message?: unknown };
  const status = e?.response?.status ?? e?.code ?? e?.status;
  if (status === 401 || status === 403) return true;
  const text = `${JSON.stringify(e?.response?.data ?? "")} ${String(e?.message ?? "")}`;
  return /invalid_grant|invalid_token|unauthorized|invalidauthenticationtoken|token has (been )?expired|revoked|\b40[13]\b/i.test(
    text
  );
}

// Generic version for calls that don't map 1:1 to a connected account (e.g. local file
// search) — just logs and drops failures, no auth tracking.
function settle<T>(results: PromiseSettledResult<T[]>[]): T[] {
  return results.flatMap((r) => {
    if (r.status === "rejected") {
      console.error("hub: provider call failed:", r.reason);
      return [];
    }
    return r.value;
  });
}

// Account-aware version — pairs each settled result with the account (or null for
// account-less sources like local files) that produced it, so an auth failure can be
// attributed to the specific connection that needs reconnecting instead of failing silently.
function settleForAccounts<T>(
  owners: (AccountRow | null)[],
  results: PromiseSettledResult<T[]>[]
): T[] {
  return results.flatMap((r, i) => {
    const owner = owners[i];
    if (r.status === "rejected") {
      console.error("hub: provider call failed:", r.reason);
      if (owner && isAuthError(r.reason)) markAccountAuthBroken(owner.id);
      return [];
    }
    if (owner) markAccountAuthHealthy(owner.id);
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
  return settleForAccounts(accounts, results).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
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
  const accounts = listAccounts();
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.provider === "google" ? g.googleListEvents(a, days) : ms.microsoftListEvents(a, days)
    )
  );
  return settleForAccounts(accounts, results).sort((a, b) => (a.start > b.start ? 1 : -1));
}

export async function hubSearchFiles(query: string): Promise<FileHit[]> {
  const googleAccounts = listAccounts("google");
  const msAccounts = listAccounts("microsoft");
  const results = await Promise.allSettled([
    ...googleAccounts.map((a) => g.googleSearchFiles(a, query)),
    ...msAccounts.map((a) => ms.microsoftSearchFiles(a, query)),
    local.localSearchFiles(query),
  ]);
  const owners: (AccountRow | null)[] = [...googleAccounts, ...msAccounts, null];
  return settleForAccounts(owners, results).sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

export async function hubListChats(limit = 20): Promise<ChatThread[]> {
  const accounts = listAccounts("microsoft");
  const results = await Promise.allSettled(accounts.map((a) => ms.microsoftListChats(a, limit)));
  return settleForAccounts(accounts, results).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function hubSearchChats(query: string, limit = 20): Promise<ChatThread[]> {
  const accounts = listAccounts("microsoft");
  const results = await Promise.allSettled(
    accounts.map((a) => ms.microsoftSearchChats(a, query, limit))
  );
  return settleForAccounts(accounts, results).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
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

export async function hubCreateEvent(
  accountId: number,
  input: EventInput
): Promise<CalendarEvent> {
  const account = requireAccount(accountId);
  return account.provider === "google"
    ? g.googleCreateEvent(account, input)
    : ms.microsoftCreateEvent(account, input);
}

export async function hubUpdateEvent(
  accountId: number,
  eventId: string,
  input: Partial<EventInput>
): Promise<CalendarEvent> {
  const account = requireAccount(accountId);
  return account.provider === "google"
    ? g.googleUpdateEvent(account, eventId, input)
    : ms.microsoftUpdateEvent(account, eventId, input);
}

export async function hubDeleteEvent(accountId: number, eventId: string): Promise<void> {
  const account = requireAccount(accountId);
  if (account.provider === "google") await g.googleDeleteEvent(account, eventId);
  else await ms.microsoftDeleteEvent(account, eventId);
}

export async function hubArchiveMessages(
  accountId: number,
  query: string,
  limit = 50
): Promise<number> {
  const account = requireAccount(accountId);
  return account.provider === "google"
    ? g.googleArchiveMessages(account, query, limit)
    : ms.microsoftArchiveMessages(account, query, limit);
}

export async function hubAddLabel(
  accountId: number,
  messageId: string,
  label: string
): Promise<void> {
  const account = requireAccount(accountId);
  if (account.provider === "google") await g.googleAddLabel(account, messageId, label);
  else await ms.microsoftAddCategory(account, messageId, label);
}

export async function hubSearchContacts(query: string, limit = 10): Promise<ContactHit[]> {
  const googleAccounts = listAccounts("google");
  const msAccounts = listAccounts("microsoft");
  const results = await Promise.allSettled([
    ...googleAccounts.map((a) => g.googleSearchContacts(a, query, limit)),
    ...msAccounts.map((a) => ms.microsoftSearchContacts(a, query, limit)),
  ]);
  return settleForAccounts([...googleAccounts, ...msAccounts], results);
}

// Heuristic: unread, older than the threshold, and not from an obviously automated sender.
// Not a true "awaiting your reply" detector (that needs thread analysis) — good enough to
// surface things that are plausibly being missed.
export const AUTOMATED_SENDER_PATTERN =
  /no-?reply|notifications?@|newsletter|updates?@|do-?not-?reply|automated|mailer-daemon/i;

export async function hubFlaggedMessages(daysThreshold = 3): Promise<UnifiedMessage[]> {
  const all = await hubListMessages({ limit: 100 });
  const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
  return all.filter((m) => {
    if (!m.unread || !m.receivedAt) return false;
    const receivedTime = new Date(m.receivedAt).getTime();
    if (Number.isNaN(receivedTime) || receivedTime > cutoff) return false;
    return !AUTOMATED_SENDER_PATTERN.test(m.from);
  });
}
