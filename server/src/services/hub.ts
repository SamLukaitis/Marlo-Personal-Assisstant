import {
  listAccounts,
  getAccount,
  markAccountAuthBroken,
  markAccountAuthHealthy,
  setAccountHistoryId,
  upsertReadEmail,
  type AccountRow,
} from "../db/store.js";
import * as g from "../providers/google.js";
import * as ms from "../providers/microsoft.js";
import * as local from "../providers/local.js";
import { eventTimeMs } from "./eventTime.js";
import type {
  UnifiedMessage,
  CalendarEvent,
  FileHit,
  DraftResult,
  ChatThread,
  ContactHit,
  EventInput,
  EmailAttachment,
  SendResult,
  UnsubscribeInfo,
} from "../providers/types.js";

// Both providers throw differently (Google's gaxios errors carry structured
// response.status/data, Microsoft's are plain Errors with the status baked into the message)
// so this checks every shape rather than assuming one. False positives just show an
// unnecessary "reconnect" prompt; false negatives just fall back to the old silent-empty
// behavior — neither is dangerous, so a lenient heuristic is the right tradeoff here.
//
// A false positive now also costs the user a WhatsApp "reconnect" message (connectionAlert.ts), so
// Gmail's rate-limit and quota 403s — a busy moment, not a dead token — are ruled out first.
function isAuthError(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: unknown }; code?: unknown; status?: unknown; message?: unknown };
  const status = e?.response?.status ?? e?.code ?? e?.status;
  const text = `${JSON.stringify(e?.response?.data ?? "")} ${String(e?.message ?? "")}`;
  if (/ratelimitexceeded|quotaexceeded|rate limit|too many requests/i.test(text)) return false;
  if (status === 401 || status === 403) return true;
  return /invalid_grant|invalid_token|unauthorized|invalidauthenticationtoken|token has (been )?expired|revoked|\b40[13]\b/i.test(
    text
  );
}

// One line per failed provider call. Logging the error object itself printed Google's whole request
// dump (~85 lines) for a dead token on every 5-minute tick, which pushed everything else out of the
// Railway log window and the Portal's Logs tab. An error with no HTTP status is something
// unexpected (a bug, a network failure), so that one keeps its stack.
export function describeProviderError(err: unknown): string {
  const e = err as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown; data?: { error_description?: unknown } };
  } | null;
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === "number" ? e.code : undefined);
  if (status === undefined && typeof e?.stack === "string") return e.stack;
  const name = typeof e?.name === "string" && e.name !== "Error" ? `${e.name}: ` : "";
  const message = String(e?.message ?? err).slice(0, 300);
  const detail = e?.response?.data?.error_description;
  return `${name}${message}${typeof detail === "string" ? ` (${detail})` : ""}${status !== undefined ? ` [${status}]` : ""}`;
}

// Generic version for calls that don't map 1:1 to a connected account (e.g. local file
// search) — just logs and drops failures, no auth tracking.
function settle<T>(results: PromiseSettledResult<T[]>[]): T[] {
  return results.flatMap((r) => {
    if (r.status === "rejected") {
      console.error(`hub: provider call failed: ${describeProviderError(r.reason)}`);
      return [];
    }
    return r.value;
  });
}

// Fire-and-forget: the caller still gets its (empty) result now. Imported lazily because
// connectionAlert -> attention -> briefing -> hub would otherwise be an import cycle.
function alertConnectionBroken(account: AccountRow): void {
  import("./connectionAlert.js")
    .then((m) => m.alertConnectionBroken(account))
    .catch((err) => console.error("hub: broken-connection alert failed", err));
}

// Account-aware version — pairs each settled result with the account (or null for
// account-less sources like local files) that produced it, so an auth failure can be
// attributed to the specific connection that needs reconnecting instead of failing silently.
// ownerId travels on the account row itself now (AccountRow.ownerId), so this needs no
// separate owner parameter beyond what's already in `owners`.
function settleForAccounts<T>(
  owners: (AccountRow | null)[],
  results: PromiseSettledResult<T[]>[]
): T[] {
  return results.flatMap((r, i) => {
    const owner = owners[i];
    if (r.status === "rejected") {
      const where = owner ? ` (account ${owner.id}, ${owner.provider}, user ${owner.ownerId})` : "";
      console.error(`hub: provider call failed${where}: ${describeProviderError(r.reason)}`);
      if (owner && isAuthError(r.reason) && markAccountAuthBroken(owner.ownerId, owner.id)) {
        alertConnectionBroken(owner);
      }
      return [];
    }
    if (owner) markAccountAuthHealthy(owner.ownerId, owner.id);
    return r.value;
  });
}

// Scoped by owner — this used to accept any account id with no ownership check (the same class
// of IDOR as the old getDocument/getAccount: /api/messages/:accountId/... could be pointed at
// any account in the DB, not just one belonging to the caller).
function requireAccount(ownerId: number, accountId: number): AccountRow {
  const account = getAccount(ownerId, accountId);
  if (!account) throw new Error(`No connected account with id ${accountId}`);
  return account;
}

// Per-inbox Read/Send/Delete toggles (Settings page "Accounts" section). "delete" here means
// archiving — Marlo never truly deletes mail, see hubArchiveMessages — the permission just
// gates that existing, reversible action.
const PERMISSION_LABEL: Record<"read" | "send" | "delete", string> = {
  read: "Reading",
  send: "Sending",
  delete: "Archiving/deleting",
};

function requirePermission(account: AccountRow, action: "read" | "send" | "delete"): void {
  const allowed = action === "read" ? account.canRead : action === "send" ? account.canSend : account.canDelete;
  if (!allowed) {
    throw new Error(
      `${PERMISSION_LABEL[action]} is turned off for ${account.email} — enable it on the Settings page under Accounts.`
    );
  }
}

// Per-tick request cache for hubListMessages's aggregate (no accountId) call. alerts.ts and
// importantEmailAlerts.ts each independently fetch the identical {limit:50} inbox window on
// every scheduler tick (scheduler.ts) — same owner, same query, same limit — so without this
// they pay for that Gmail fetch (and its messages.get fan-out, see google.ts) twice for no
// reason. Keyed on the exact (ownerId, query, limit) triple rather than trying to serve a
// smaller request from a larger cached one: a multi-account owner gets up to `limit` messages
// *per account* (this function never caps the merged total), so slicing a merged/sorted result
// would silently shortchange whichever account sorted lower — worse than just not deduping that
// case. reconciliation.ts's 150-message scan therefore isn't deduped against the two 50-message
// calls, but its own per-call cost was already fixed at the source (google.ts's concurrency cap).
//
// Explicitly opt-in via withMessageCache so interactive callers — the assistant's tools, the
// Assistant page — always see a freshly-fetched inbox; the cache only exists for the duration of
// one withMessageCache(...) call.
//
// The same scope also defers saving Gmail/Outlook new-mail checkpoints (see hubListNewMessages) until every
// scanner in the tick has run, so a scanner that deliberately leaves mail unhandled for a retry can
// hold the checkpoint with holdNewMessageCheckpoint — otherwise the next tick's incremental fetch
// would start past that mail and it would never be seen again.
interface TickScope {
  cache: Map<string, Promise<UnifiedMessage[]>>;
  pendingCheckpoints: { ownerId: number; accountId: number; historyId: string }[];
  heldOwners: Set<number>;
}

let tickScope: TickScope | null = null;

// A failure that never clears (a number WhatsApp permanently rejects, say) would otherwise pin the
// checkpoint forever, and every tick would re-fetch an ever-growing window of mail — the exact
// quota problem the incremental fetch exists to avoid. Past this, the checkpoint moves on anyway.
const MAX_CHECKPOINT_HOLD_MS = 60 * 60 * 1000;
const holdStartedAt = new Map<number, number>();

// A connection already flagged as expired fails the same way on every background scan: the user
// has been told (connectionAlert.ts) and only reconnecting fixes it. The scans skip it rather than
// calling the provider every 5 minutes, and look again every few hours in case it was flagged by
// mistake (a success clears the flag, see settleForAccounts). Chat lookups are not affected: they
// always try, since someone is waiting on the answer.
const BROKEN_ACCOUNT_REPROBE_MS = 6 * 60 * 60 * 1000;
const lastBrokenProbeAt = new Map<number, number>();

export function accountsForBackgroundScan(accounts: AccountRow[], now = Date.now()): AccountRow[] {
  return accounts.filter((a) => {
    if (!a.authBroken) {
      lastBrokenProbeAt.delete(a.id);
      return true;
    }
    const last = lastBrokenProbeAt.get(a.id) ?? a.authBrokenAt ?? 0;
    if (now - last < BROKEN_ACCOUNT_REPROBE_MS) return false;
    lastBrokenProbeAt.set(a.id, now);
    return true;
  });
}

export function withMessageCache<T>(fn: () => Promise<T>): Promise<T> {
  const isOutermost = tickScope === null;
  if (isOutermost) tickScope = { cache: new Map(), pendingCheckpoints: [], heldOwners: new Set() };
  const scope = tickScope!;
  return fn().then(
    (result) => {
      if (isOutermost) {
        tickScope = null;
        commitCheckpoints(scope);
      }
      return result;
    },
    (err) => {
      // Something threw past the scanners' own error handling — don't assume the mail was handled.
      if (isOutermost) tickScope = null;
      throw err;
    }
  );
}

// Called by a scanner that left new mail unhandled on purpose so it can retry next tick (failed
// classification, failed delivery). Only meaningful inside withMessageCache — outside a scope the
// checkpoint has already been saved by the time any caller could ask.
export function holdNewMessageCheckpoint(ownerId: number): void {
  tickScope?.heldOwners.add(ownerId);
}

function commitCheckpoints(scope: TickScope): void {
  const now = Date.now();
  const skipOwners = new Set<number>();
  for (const ownerId of scope.heldOwners) {
    const startedAt = holdStartedAt.get(ownerId) ?? now;
    holdStartedAt.set(ownerId, startedAt);
    if (now - startedAt < MAX_CHECKPOINT_HOLD_MS) {
      skipOwners.add(ownerId);
    } else {
      console.warn(`hub: releasing a new-mail checkpoint held over an hour for owner ${ownerId}`);
    }
  }
  for (const { ownerId, accountId, historyId } of scope.pendingCheckpoints) {
    if (skipOwners.has(ownerId)) continue;
    setAccountHistoryId(ownerId, accountId, historyId);
    holdStartedAt.delete(ownerId);
  }
}

// Every message this returns already crossed the wire (Gmail/Outlook's list call includes
// subject/from/snippet/date at no extra cost — see google.ts's messages.get(format: "metadata")
// comment) so persisting it here is free: no extra provider call, no LLM call. This is what lets
// a later question about ANY previously listed/searched email (not just ones the classifier
// flagged as important) be answered from real stored data instead of the model's memory of its
// own past reply — see search_read_emails in assistant.ts. Deliberately unconditional (every
// caller of hubListMessages: search_messages, list_recent_messages, the background scans) rather
// than gated to one code path, so nothing needs to remember to opt in.
function cacheMessageMetadata(accounts: AccountRow[], messages: UnifiedMessage[]): void {
  const ownerId = accounts[0]?.ownerId;
  if (ownerId === undefined) return;
  for (const m of messages) upsertReadEmail(ownerId, m);
}

async function fetchMessages(
  accounts: AccountRow[],
  opts: { query?: string; limit?: number }
): Promise<UnifiedMessage[]> {
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.provider === "google"
        ? g.googleListMessages(a, opts)
        : ms.microsoftListMessages(a, opts)
    )
  );
  const messages = settleForAccounts(accounts, results).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  cacheMessageMetadata(accounts, messages);
  return messages;
}

export async function hubListMessages(
  ownerId: number,
  opts: { query?: string; limit?: number; accountId?: number }
): Promise<UnifiedMessage[]> {
  if (opts.accountId) {
    const account = requireAccount(ownerId, opts.accountId);
    requirePermission(account, "read");
    return fetchMessages([account], opts);
  }

  // Aggregate "all accounts" call (briefing, alerts, "what's unread") — silently exclude
  // read-restricted accounts rather than erroring, same posture as auth-broken accounts below.
  if (tickScope) {
    const key = `${ownerId}:${opts.query ?? ""}:${opts.limit ?? 20}`;
    const cached = tickScope.cache.get(key);
    if (cached) return cached;
    const accounts = accountsForBackgroundScan(listAccounts(ownerId).filter((a) => a.canRead));
    const promise = fetchMessages(accounts, opts);
    tickScope.cache.set(key, promise);
    return promise;
  }

  const accounts = listAccounts(ownerId).filter((a) => a.canRead);
  return fetchMessages(accounts, opts);
}

// A Gmail account with no checkpoint yet (or one Gmail has expired) falls back to a full list —
// see google.ts's googleListNewMessages — bounded by this one fixed window rather than a
// per-caller limit, since after that one-time baseline "new" has no limit at all, it's just
// whatever changed. Matches reconciliation.ts's current window, the widest of the three
// existing background scans, so no caller loses catch-up coverage on first run.
const HISTORY_BASELINE_LIMIT = 150;

async function fetchNewMessages(accounts: AccountRow[]): Promise<UnifiedMessage[]> {
  const results = await Promise.allSettled(
    accounts.map(async (a) => {
      // Only reached once the provider has actually fetched every message it found — a failed
      // fetch rejects before this, leaving the old checkpoint in place for the next tick. Gmail's
      // checkpoint is a History API id, Outlook's a Graph delta link; both live in history_id.
      const { messages, historyId } =
        a.provider === "google"
          ? await g.googleListNewMessages(a, { limit: HISTORY_BASELINE_LIMIT })
          : await ms.microsoftListNewMessages(a, { limit: HISTORY_BASELINE_LIMIT });
      if (historyId) {
        if (tickScope) {
          tickScope.pendingCheckpoints.push({ ownerId: a.ownerId, accountId: a.id, historyId });
        } else {
          setAccountHistoryId(a.ownerId, a.id, historyId);
        }
      }
      return messages;
    })
  );
  const messages = settleForAccounts(accounts, results).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  cacheMessageMetadata(accounts, messages);
  // "New" never reaches back before the mailbox was connected (store.ts's accounts.connected_at).
  // Without this floor, anything that gave an account a fresh id — replaying onboarding, a
  // disconnect/reconnect, adding a second mailbox — handed its whole pre-connect backlog to the
  // scanners as unseen mail, since their ledgers key on accountId and their owner-level baseline
  // flags were already set. The pre-connect window is postConnectSetup's one-time preview's job.
  const connectedAt = new Map(accounts.map((a) => [a.id, a.connectedAt]));
  return messages.filter((m) => {
    const floor = connectedAt.get(m.accountId);
    if (floor && new Date(m.receivedAt).getTime() < floor) return false;
    // The user's own mail is never "new mail" for the scanners to alert on — google.ts already
    // drops drafts and sent replies by label; this catches whatever a provider still lets through.
    return !isFromAccountOwner(m);
  });
}

// True when the message was written from the mailbox it sits in (the user's own reply or draft).
export function isFromAccountOwner(m: Pick<UnifiedMessage, "from" | "accountEmail">): boolean {
  const address = (m.from.match(/<([^>]+)>/)?.[1] ?? m.from).trim().toLowerCase();
  return !!address && address === m.accountEmail.trim().toLowerCase();
}

// Backs the three background "what's new" scans (alerts.ts, importantEmailAlerts.ts,
// reconciliation.ts) — none of which pass a search query, and each of which independently
// decides whether to act on a message via its own ledger (hasAlerted, recon-match:, ...), but
// all of which mean the same thing by "new": everything since the last time any of them
// checked. So this deliberately shares ONE fetch — and one checkpoint advance — across all
// three, keyed without `limit` (unlike hubListMessages's cache key) precisely because the
// different limits they used to pass were never a real difference in what they wanted, just
// three different proxies for the same "how far to look" bound on a full list. Only the one-time
// baseline (no checkpoint yet) actually reads a limit at all — see HISTORY_BASELINE_LIMIT — and
// that's shared too, not per-caller: whichever of the three runs first within one
// withMessageCache tick decides it, same as any other cached fetch.
export async function hubListNewMessages(ownerId: number): Promise<UnifiedMessage[]> {
  const accounts = accountsForBackgroundScan(listAccounts(ownerId).filter((a) => a.canRead));
  if (tickScope) {
    const key = `${ownerId}:new`;
    const cached = tickScope.cache.get(key);
    if (cached) return cached;
    const promise = fetchNewMessages(accounts);
    tickScope.cache.set(key, promise);
    return promise;
  }
  return fetchNewMessages(accounts);
}

export async function hubGetMessage(
  ownerId: number,
  accountId: number,
  messageId: string
): Promise<UnifiedMessage | null> {
  const account = requireAccount(ownerId, accountId);
  requirePermission(account, "read");
  const message =
    account.provider === "google"
      ? await g.googleGetMessage(account, messageId)
      : await ms.microsoftGetMessage(account, messageId);
  // Full body, on top of whatever metadata a prior list already cached — every caller (the
  // assistant's get_message tool, the extract_email_attachment flow, the invoice-attachment
  // check in importantEmailAlerts.ts, the web UI's message view) gets this for free.
  if (message) upsertReadEmail(ownerId, message);
  return message;
}

export async function hubGetUnsubscribeInfo(
  ownerId: number,
  accountId: number,
  messageId: string
): Promise<UnsubscribeInfo | null> {
  const account = requireAccount(ownerId, accountId);
  requirePermission(account, "read");
  return account.provider === "google"
    ? g.googleGetUnsubscribeInfo(account, messageId)
    : ms.microsoftGetUnsubscribeInfo(account, messageId);
}

export async function hubGetAttachment(
  ownerId: number,
  accountId: number,
  messageId: string,
  attachmentId: string
): Promise<{ data: Buffer } | null> {
  const account = requireAccount(ownerId, accountId);
  requirePermission(account, "read");
  return account.provider === "google"
    ? g.googleGetAttachment(account, messageId, attachmentId)
    : ms.microsoftGetAttachment(account, messageId, attachmentId);
}

export async function hubListEvents(ownerId: number, days = 7): Promise<CalendarEvent[]> {
  const accounts = listAccounts(ownerId);
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.provider === "google" ? g.googleListEvents(a, days) : ms.microsoftListEvents(a, days)
    )
  );
  // Providers return different string shapes (UTC "Z", "+02:00" offsets, all-day dates), so
  // sort by the actual instant rather than comparing the strings.
  return settleForAccounts(accounts, results).sort((a, b) => eventTimeMs(a.start) - eventTimeMs(b.start));
}

/**
 * Events between two instants across every connected account, for answering "am I free then?".
 * `complete` is false when there is no account at all or any account failed to answer, because a
 * calendar that couldn't be read says nothing about whether the person is free.
 */
export async function hubListEventsBetween(
  ownerId: number,
  from: Date,
  to: Date
): Promise<{ events: CalendarEvent[]; complete: boolean }> {
  const accounts = listAccounts(ownerId);
  if (accounts.length === 0) return { events: [], complete: false };
  const results = await Promise.allSettled(
    accounts.map((a) =>
      a.provider === "google" ? g.googleListEventsBetween(a, from, to) : ms.microsoftListEventsBetween(a, from, to)
    )
  );
  const complete = results.every((r) => r.status === "fulfilled");
  return { events: settleForAccounts(accounts, results), complete };
}

export async function hubSearchFiles(ownerId: number, query: string): Promise<FileHit[]> {
  const googleAccounts = listAccounts(ownerId, "google");
  const msAccounts = listAccounts(ownerId, "microsoft");
  const results = await Promise.allSettled([
    ...googleAccounts.map((a) => g.googleSearchFiles(a, query)),
    ...msAccounts.map((a) => ms.microsoftSearchFiles(a, query)),
    local.localSearchFiles(ownerId, query),
  ]);
  const owners: (AccountRow | null)[] = [...googleAccounts, ...msAccounts, null];
  return settleForAccounts(owners, results).sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}

// Teams chat only exists for work/school Microsoft accounts — a personal Outlook.com/Hotmail
// account gets a 403 here even though its mailbox connection is perfectly healthy. So chat
// failures are logged and dropped via settle, never attributed to the account the way
// settleForAccounts would (which flagged the whole mailbox as needing a reconnect).
export async function hubListChats(ownerId: number, limit = 20): Promise<ChatThread[]> {
  const accounts = listAccounts(ownerId, "microsoft");
  const results = await Promise.allSettled(accounts.map((a) => ms.microsoftListChats(a, limit)));
  return settle(results).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function hubSearchChats(ownerId: number, query: string, limit = 20): Promise<ChatThread[]> {
  const accounts = listAccounts(ownerId, "microsoft");
  const results = await Promise.allSettled(
    accounts.map((a) => ms.microsoftSearchChats(a, query, limit))
  );
  return settle(results).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function hubCreateDraft(
  ownerId: number,
  accountId: number,
  to: string,
  subject: string,
  body: string
): Promise<DraftResult> {
  const account = requireAccount(ownerId, accountId);
  return account.provider === "google"
    ? g.googleCreateDraft(account, to, subject, body)
    : ms.microsoftCreateDraft(account, to, subject, body);
}

// An Outlook account connected before Mail.Send was requested throws ms.OutlookSendPermissionError
// here — callers that can offer a reconnect link check for it (see outlookSendReconnect.ts).
export async function hubSendMessage(
  ownerId: number,
  accountId: number,
  to: string,
  subject: string,
  body: string,
  attachment?: EmailAttachment
): Promise<SendResult> {
  const account = requireAccount(ownerId, accountId);
  requirePermission(account, "send");
  return account.provider === "google"
    ? g.googleSendMessage(account, to, subject, body, attachment)
    : ms.microsoftSendMessage(account, to, subject, body, attachment);
}

export async function hubHasSentTo(ownerId: number, accountId: number, address: string): Promise<boolean> {
  const account = requireAccount(ownerId, accountId);
  return account.provider === "google"
    ? g.googleHasSentTo(account, address)
    : ms.microsoftHasSentTo(account, address);
}

export async function hubCreateEvent(
  ownerId: number,
  accountId: number,
  input: EventInput
): Promise<CalendarEvent> {
  const account = requireAccount(ownerId, accountId);
  return account.provider === "google"
    ? g.googleCreateEvent(account, input)
    : ms.microsoftCreateEvent(account, input);
}

export async function hubUpdateEvent(
  ownerId: number,
  accountId: number,
  eventId: string,
  input: Partial<EventInput>
): Promise<CalendarEvent> {
  const account = requireAccount(ownerId, accountId);
  return account.provider === "google"
    ? g.googleUpdateEvent(account, eventId, input)
    : ms.microsoftUpdateEvent(account, eventId, input);
}

export async function hubDeleteEvent(ownerId: number, accountId: number, eventId: string): Promise<void> {
  const account = requireAccount(ownerId, accountId);
  if (account.provider === "google") await g.googleDeleteEvent(account, eventId);
  else await ms.microsoftDeleteEvent(account, eventId);
}

export async function hubArchiveMessages(
  ownerId: number,
  accountId: number,
  query: string,
  limit = 50
): Promise<number> {
  const account = requireAccount(ownerId, accountId);
  requirePermission(account, "delete");
  return account.provider === "google"
    ? g.googleArchiveMessages(account, query, limit)
    : ms.microsoftArchiveMessages(account, query, limit);
}

export async function hubAddLabel(
  ownerId: number,
  accountId: number,
  messageId: string,
  label: string
): Promise<void> {
  const account = requireAccount(ownerId, accountId);
  if (account.provider === "google") await g.googleAddLabel(account, messageId, label);
  else await ms.microsoftAddCategory(account, messageId, label);
}

export async function hubSearchContacts(ownerId: number, query: string, limit = 10): Promise<ContactHit[]> {
  const googleAccounts = listAccounts(ownerId, "google");
  const msAccounts = listAccounts(ownerId, "microsoft");
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

// The one "is this automated mail rather than a person writing?" check, shared by every feature
// that splits mail that way: the real-person alerts (alerts.ts), the important-automated-mail
// scan (importantEmailAlerts.ts) and list_needs_attention (hubFlaggedMessages below). The address
// pattern alone missed modern marketing senders (Pinterest, Babbel, ...) whose From addresses look
// ordinary, so they pinged as "X emailed you" — the provider's own bulk signal catches those.
// Sharing it keeps the two alert features complementary: whatever leaves the real-person bucket
// lands in the classifier's, so a useful delivery notice from such a sender still gets through.
export function isAutomatedMail(m: Pick<UnifiedMessage, "from" | "bulk">): boolean {
  return m.bulk === true || AUTOMATED_SENDER_PATTERN.test(m.from);
}

// Extracts a human-readable name from a raw From header — "Jane Doe <jane@x.com>",
// "jane@x.com", or a bare display name with no address at all. Alert text sent to the user
// should read like a person wrote it, never show a raw email address.
export function senderDisplayName(from: string): string {
  const quoted = from.match(/^"([^"]+)"\s*<[^>]+>$/);
  if (quoted) return quoted[1].trim();
  const bare = from.match(/^([^<]+)<[^>]+>$/);
  if (bare) return bare[1].trim();
  const at = from.indexOf("@");
  return at > 0 ? from.slice(0, at) : from.trim();
}

export async function hubFlaggedMessages(ownerId: number, daysThreshold = 3): Promise<UnifiedMessage[]> {
  const all = await hubListMessages(ownerId, { limit: 100 });
  const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;
  return all.filter((m) => {
    if (!m.unread || !m.receivedAt) return false;
    const receivedTime = new Date(m.receivedAt).getTime();
    if (Number.isNaN(receivedTime) || receivedTime > cutoff) return false;
    return !isAutomatedMail(m);
  });
}
