import { updateAccountTokens, type AccountRow } from "../db/store.js";
import { mapWithConcurrency } from "../services/concurrency.js";
import { htmlToText } from "../services/htmlToText.js";
import type {
  UnifiedMessage,
  CalendarEvent,
  DraftResult,
  FileHit,
  ChatThread,
  ContactHit,
  EventInput,
  EmailAttachment,
  SendResult,
  UnsubscribeInfo,
} from "./types.js";

const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
// openid makes the token endpoint return an id_token — the tenant id + object id in it are how a
// person is identified (see exchangeMicrosoftCode), never the editable `mail` profile field.
// profile is what puts `oid` in that id_token: Microsoft gates the claim on it ("the profile scope
// is required to receive this claim"), so openid alone returns sub + tid but no oid and every
// sign-in fails in readIdTokenIdentity. Don't drop it.
// Mail.Send was added after the first Outlook accounts connected: their refresh tokens still carry
// only the original scopes, so microsoftSendMessage raises OutlookSendPermissionError for them and
// the reconnect is asked for only at the moment they actually try to send.
const SCOPES =
  "openid profile offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Chat.Read Files.Read People.Read";

export function isMicrosoftConfigured(): boolean {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

function redirectUri(): string {
  return process.env.MS_REDIRECT_URI ?? "http://localhost:4000/auth/microsoft/callback";
}

// loginHint preselects an account on Microsoft's picker — same param name as Google's, optional
// so every existing call site keeps working unchanged with it omitted.
export function getMicrosoftAuthUrl(state: string, loginHint?: string): string {
  if (!isMicrosoftConfigured()) {
    throw new Error("MS_CLIENT_ID / MS_CLIENT_SECRET are not set in the environment");
  }
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID!,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPES,
    prompt: "select_account",
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string; // space-separated scopes this token actually carries
}

// The id_token comes straight back from Microsoft's token endpoint over TLS, in exchange for this
// app's own code + client secret — the OIDC authorization-code case where its claims can be read
// without separately verifying the signature.
function readIdTokenIdentity(idToken: string | undefined): { tenantId: string; objectId: string } {
  const payload = idToken?.split(".")[1];
  if (!payload) throw new Error("Microsoft did not return an id_token for this sign-in");
  let claims: { tid?: unknown; oid?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Microsoft returned an unreadable id_token");
  }
  if (typeof claims.tid !== "string" || typeof claims.oid !== "string") {
    throw new Error("Microsoft's id_token is missing the tenant/object id claims");
  }
  return { tenantId: claims.tid, objectId: claims.oid };
}

async function exchangeToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID!,
      client_secret: process.env.MS_CLIENT_SECRET!,
      ...body,
    }),
  });
  if (!res.ok) {
    throw new Error(`Microsoft token endpoint returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export interface ExchangedMicrosoftAuth {
  // A display label and the mailbox address only — a tenant admin can set this to anything, so it
  // must never decide which user someone is. Use tenantId/objectId for that.
  email: string;
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number;
  tenantId: string;
  objectId: string;
  // Graph's /me id — compared against microsoftGetGraphUserId(stored account) to prove a new sign-in
  // is the same Microsoft account already connected to an existing user (see authRoutes.ts).
  graphUserId: string;
}

export function microsoftIdentitySubject(auth: Pick<ExchangedMicrosoftAuth, "tenantId" | "objectId">): string {
  return `${auth.tenantId}:${auth.objectId}`;
}

// Exchanges an OAuth code for tokens + the account's identity, with no DB write — shared by the
// "log into the app", "connect a data source", and WhatsApp registration flows (authRoutes.ts).
export async function exchangeMicrosoftCode(code: string): Promise<ExchangedMicrosoftAuth> {
  const tokens = await exchangeToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });

  const profileRes = await fetch(`${GRAPH}/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) throw new Error(`Graph /me returned ${profileRes.status}`);
  const profile = (await profileRes.json()) as { id?: string; mail?: string; userPrincipalName?: string };
  const email = profile.mail ?? profile.userPrincipalName;
  if (!email) throw new Error("Microsoft did not return an email for this account");
  if (!profile.id) throw new Error("Microsoft did not return a user id for this account");

  return {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: Date.now() + tokens.expires_in * 1000,
    ...readIdTokenIdentity(tokens.id_token),
    graphUserId: profile.id,
  };
}

// Which Microsoft user a stored account's tokens belong to — null if they no longer work (revoked,
// expired refresh token), in which case nothing can be proven with it.
export async function microsoftGetGraphUserId(account: AccountRow): Promise<string | null> {
  try {
    const me = await graphGet<{ id?: string }>(account, "/me?$select=id");
    return me.id ?? null;
  } catch {
    return null;
  }
}

/** Returns a valid access token, refreshing (and persisting) if near expiry. */
async function accessTokenFor(account: AccountRow): Promise<string> {
  const stillValid =
    account.accessToken && account.expiryDate && account.expiryDate > Date.now() + 60_000;
  if (stillValid) return account.accessToken!;

  return (await refreshTokens(account)).access_token;
}

async function refreshTokens(account: AccountRow): Promise<TokenResponse> {
  if (!account.refreshToken) throw new Error(`No refresh token for ${account.email}`);
  const tokens = await exchangeToken({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });
  updateAccountTokens(account.ownerId, account.id, {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? undefined,
    expiryDate: Date.now() + tokens.expires_in * 1000,
  });
  return tokens;
}

const GRAPH_MAX_ATTEMPTS = 5;
const GRAPH_MAX_RETRY_WAIT_MS = 30_000;

/**
 * fetch against Graph, retrying when Graph throttles. Outlook caps each app at ~4 requests in flight
 * per mailbox (429 "MailboxConcurrency"), and the assistant runs tools in parallel alongside
 * background scans, so hitting it is routine rather than exceptional. A 429 means the request was
 * refused, so it's safe to retry any method; 503/504 only for GETs, since a write may have landed.
 */
async function graphFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    const retryable = res.status === 429 || (method === "GET" && (res.status === 503 || res.status === 504));
    if (!retryable || attempt >= GRAPH_MAX_ATTEMPTS) return res;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
  }
}

// Graph's Retry-After is in seconds; without one, back off exponentially with jitter.
function retryDelayMs(res: Response, attempt: number): number {
  const header = Number(res.headers?.get?.("retry-after"));
  const ms = Number.isFinite(header) && header >= 0 ? header * 1000 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
  return Math.min(ms, GRAPH_MAX_RETRY_WAIT_MS);
}

async function graphGet<T>(account: AccountRow, path: string, extraHeaders: Record<string, string> = {}): Promise<T> {
  const token = await accessTokenFor(account);
  // Absolute URLs are Graph's own paging/delta links (@odata.nextLink / @odata.deltaLink).
  const url = path.startsWith("https://") ? path : `${GRAPH}${path}`;
  const res = await graphFetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });
  if (!res.ok) {
    throw new GraphHttpError(res.status, `Graph ${path.slice(0, 200)} returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Same message text as before (hub.ts's isAuthError reads the status out of it), plus the status
// as a field for callers that branch on it.
class GraphHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function graphPost<T>(account: AccountRow, path: string, body: unknown): Promise<T> {
  const token = await accessTokenFor(account);
  const res = await graphFetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function graphPatch<T>(account: AccountRow, path: string, body: unknown): Promise<T> {
  const token = await accessTokenFor(account);
  const res = await graphFetch(`${GRAPH}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function graphDelete(account: AccountRow, path: string): Promise<void> {
  const token = await accessTokenFor(account);
  const res = await graphFetch(`${GRAPH}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
}

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  webLink?: string;
  body?: { content?: string; contentType?: string };
  hasAttachments?: boolean;
  internetMessageHeaders?: { name?: string; value?: string }[];
}

interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
}

function toUnified(account: AccountRow, m: GraphMessage): UnifiedMessage {
  const from = m.from?.emailAddress;
  return {
    id: m.id,
    accountId: account.id,
    accountEmail: account.email,
    provider: "microsoft",
    subject: m.subject || "(no subject)",
    from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
    snippet: m.bodyPreview ?? "",
    receivedAt: m.receivedDateTime ?? "",
    unread: m.isRead === false,
    // Same signal google.ts's isBulk uses: every marketing platform sets List-Unsubscribe however
    // ordinary its From address looks. Without it Outlook mail (UNiDAYS, Pinterest, ...) had no
    // bulk signal at all and pinged as "X emailed you".
    bulk: (m.internetMessageHeaders ?? []).some(
      (h) => h.name?.toLowerCase() === "list-unsubscribe" && !!h.value
    ),
    link: m.webLink,
  };
}

const MSG_SELECT =
  "$select=id,subject,from,bodyPreview,receivedDateTime,isRead,webLink,internetMessageHeaders";

// The assistant writes Gmail search syntax (search_messages's tool description says so, and it's
// what the model reaches for anyway), but Graph's $search is KQL: newer_than:, is:unread, in:inbox
// and has:attachment either matched nothing or broke the request. This maps the Gmail operators
// that have a Graph equivalent and drops the ones that don't (label:, category:, is:starred, ...)
// rather than letting them turn a real search into an empty one. from:/to:/subject: and plain
// words are the same in both and pass straight through.
export interface GraphMailQuery {
  kql: string; // remaining free text + passthrough operators, "" when there are none
  folder: "inbox" | "sentitems" | "drafts" | null; // null = every folder
  receivedAfter?: string; // YYYY-MM-DD, inclusive
  receivedBefore?: string; // YYYY-MM-DD, exclusive
  hasAttachment?: boolean;
  unread?: boolean;
}

const FOLDER_FOR_IN: Record<string, GraphMailQuery["folder"]> = {
  inbox: "inbox",
  sent: "sentitems",
  drafts: "drafts",
  anywhere: null,
  all: null,
};

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Gmail's relative age: 7d, 2w, 3m, 1y (and h, which Graph can only honour to the day).
function relativeAgeMs(value: string): number | null {
  const m = /^(\d+)([hdwmy])$/i.exec(value);
  if (!m) return null;
  const unitMs = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, y: 365 * 86400e3 }[
    m[2].toLowerCase() as "h" | "d" | "w" | "m" | "y"
  ];
  return Number(m[1]) * unitMs;
}

// Gmail accepts 2026/09/01 and 2026-09-01 (and single-digit month/day).
function absoluteDay(value: string): string | null {
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export function toGraphMailQuery(query: string, now = Date.now()): GraphMailQuery {
  const result: GraphMailQuery = { kql: "", folder: null };
  const kept: string[] = [];
  const tokens = query.match(/[^\s:"]+:"[^"]*"|"[^"]*"|\S+/g) ?? [];
  for (const token of tokens) {
    const op = /^([a-z_]+):(.*)$/i.exec(token);
    if (!op) {
      kept.push(token);
      continue;
    }
    const name = op[1].toLowerCase();
    const value = op[2].replace(/^"|"$/g, "");
    const lower = value.toLowerCase();
    switch (name) {
      case "in":
        if (lower in FOLDER_FOR_IN) result.folder = FOLDER_FOR_IN[lower];
        break;
      case "is":
        if (lower === "unread") result.unread = true;
        else if (lower === "read") result.unread = false;
        break;
      case "has":
        if (lower === "attachment") result.hasAttachment = true;
        break;
      case "filename":
        kept.push(`attachment:${op[2]}`);
        break;
      case "newer_than":
      case "older_than": {
        const age = relativeAgeMs(value);
        if (age === null) break;
        if (name === "newer_than") result.receivedAfter = isoDay(now - age);
        else result.receivedBefore = isoDay(now - age);
        break;
      }
      case "after":
      case "before": {
        const day = absoluteDay(value);
        if (!day) break;
        if (name === "after") result.receivedAfter = day;
        else result.receivedBefore = day;
        break;
      }
      case "label":
      case "category":
      case "newer":
      case "older":
        break;
      default:
        kept.push(token); // from:, to:, cc:, subject:, ... — KQL spells these the same way
    }
  }
  result.kql = kept.join(" ");
  return result;
}

function folderPath(folder: GraphMailQuery["folder"]): string {
  return folder ? `/me/mailFolders/${folder}/messages` : "/me/messages";
}

// Builds the Graph request for a translated query. $search and $filter can't be combined on
// messages, so with free text the date/attachment bounds go into the KQL itself; with none, they
// become a $filter so the listing can still be date-ordered (Graph requires the $orderby property
// to lead the $filter, hence the always-present receivedDateTime bound).
function graphMessagesPath(q: GraphMailQuery, top: number, select: string): string {
  const base = folderPath(q.folder);
  if (q.kql) {
    const kql = [
      q.kql,
      ...(q.hasAttachment ? ["hasAttachments:true"] : []),
      ...(q.receivedAfter ? [`received>=${q.receivedAfter}`] : []),
      ...(q.receivedBefore ? [`received<${q.receivedBefore}`] : []),
    ].join(" ");
    return `${base}?$search="${encodeURIComponent(kql.replace(/"/g, '\\"'))}"&$top=${top}&${select}`;
  }
  const filters = [
    `receivedDateTime ge ${q.receivedAfter ?? "1900-01-01"}T00:00:00Z`,
    ...(q.receivedBefore ? [`receivedDateTime lt ${q.receivedBefore}T00:00:00Z`] : []),
    ...(q.hasAttachment ? ["hasAttachments eq true"] : []),
    ...(q.unread !== undefined ? [`isRead eq ${!q.unread}`] : []),
  ];
  return (
    `${base}?$filter=${encodeURIComponent(filters.join(" and "))}` +
    `&$orderby=receivedDateTime desc&$top=${top}&${select}`
  );
}

export async function microsoftListMessages(
  account: AccountRow,
  opts: { query?: string; limit?: number } = {}
): Promise<UnifiedMessage[]> {
  const top = opts.limit ?? 20;
  // Without a search query, "list recent messages" should mean the inbox —
  // /me/messages otherwise returns messages from every folder, archived or not.
  if (!opts.query?.trim()) {
    const data = await graphGet<{ value: GraphMessage[] }>(
      account,
      `/me/mailFolders/inbox/messages?$orderby=receivedDateTime desc&$top=${top}&${MSG_SELECT}`
    );
    return data.value.map((m) => toUnified(account, m));
  }
  const q = toGraphMailQuery(opts.query);
  const data = await graphGet<{ value: GraphMessage[] }>(account, graphMessagesPath(q, top, MSG_SELECT));
  const messages = data.value.map((m) => toUnified(account, m));
  // KQL can't express read state, so with free text is:unread/is:read is applied here instead.
  if (q.kql && q.unread !== undefined) return messages.filter((m) => m.unread === q.unread);
  return messages;
}

export interface NewMessagesResult {
  messages: UnifiedMessage[];
  // The delta link to resume from next time. Stored in the same accounts.history_id column as
  // Gmail's historyId, and like it, deliberately NOT saved here — hub.ts saves it once the tick's
  // scanners have handled the messages (see google.ts's googleListNewMessages).
  historyId: string | null;
}

interface DeltaPage {
  value: { id: string; receivedDateTime?: string; "@removed"?: unknown }[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

const INBOX_DELTA = "/me/mailFolders/inbox/messages/delta";
// Exchange's clock and ours can disagree by a little; starting the baseline this far back means a
// message landing during the baseline is seen twice (harmless — every scanner dedupes on its own
// ledger) rather than never (the unsafe direction).
const DELTA_BASELINE_SKEW_MS = 10 * 60 * 1000;
// Delta also reports messages that merely *changed* — read, flagged, categorised. Gmail's history
// is asked for additions only; Graph can't filter that way, so anything received this long before
// now is a change to old mail, not new mail, and isn't worth a fetch. Far longer than
// hub.ts's MAX_CHECKPOINT_HOLD_MS, so a held checkpoint can never age genuinely new mail out.
const DELTA_NEW_MAIL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const GRAPH_GET_CONCURRENCY = 4;

function isDeltaExpired(err: unknown): boolean {
  if (!(err instanceof GraphHttpError)) return false;
  return err.status === 410 || /syncstate|resyncrequired/i.test(err.message);
}

// Walks a delta round to its end, collecting ids. Returns the new delta link.
async function walkDelta(account: AccountRow, start: string): Promise<{ ids: DeltaPage["value"]; deltaLink: string | null }> {
  const ids: DeltaPage["value"] = [];
  let next: string | undefined = start;
  let deltaLink: string | null = null;
  while (next) {
    const page: DeltaPage = await graphGet<DeltaPage>(account, next, { Prefer: "odata.maxpagesize=100" });
    ids.push(...page.value);
    next = page["@odata.nextLink"];
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
  }
  return { ids, deltaLink };
}

// Outlook's version of googleListNewMessages: a Graph delta query over the inbox returns only what
// changed since the stored delta link, instead of re-listing the newest 150 messages (with all
// their headers) on every 5-minute tick. The delta round itself asks for ids and dates only; the
// handful of genuinely new messages are then fetched individually with the usual fields, the same
// shape as Gmail's history.list + messages.get.
//
// No checkpoint yet (first run, or Graph says the old one expired): starts a delta round filtered to
// mail received from now on — so it returns almost nothing and costs one call — and does a normal
// inbox list for this tick's messages, exactly like google.ts's baselineAndList.
export async function microsoftListNewMessages(
  account: AccountRow,
  opts: { limit?: number } = {}
): Promise<NewMessagesResult> {
  if (account.historyId) {
    try {
      return await incrementalNewMessages(account, account.historyId);
    } catch (err) {
      if (!isDeltaExpired(err)) throw err;
    }
  }
  return baselineNewMessages(account, opts.limit ?? 20);
}

async function baselineNewMessages(account: AccountRow, limit: number): Promise<NewMessagesResult> {
  // Captured BEFORE the list — see google.ts's baselineAndList for why that's the safe order.
  const since = new Date(Date.now() - DELTA_BASELINE_SKEW_MS).toISOString();
  const filter = encodeURIComponent(`receivedDateTime ge ${since}`);
  const { deltaLink } = await walkDelta(account, `${INBOX_DELTA}?$select=id,receivedDateTime&$filter=${filter}`);
  const messages = await microsoftListMessages(account, { limit });
  return { messages, historyId: deltaLink };
}

async function incrementalNewMessages(account: AccountRow, deltaLink: string): Promise<NewMessagesResult> {
  const { ids, deltaLink: nextLink } = await walkDelta(account, deltaLink);
  const floor = Date.now() - DELTA_NEW_MAIL_WINDOW_MS;
  const fresh = [
    ...new Set(
      ids
        .filter((item) => !item["@removed"])
        .filter((item) => !item.receivedDateTime || Date.parse(item.receivedDateTime) >= floor)
        .map((item) => item.id)
    ),
  ];
  const fetched = await mapWithConcurrency(fresh, GRAPH_GET_CONCURRENCY, async (id) => {
    try {
      const m = await graphGet<GraphMessage>(account, `/me/messages/${encodeURIComponent(id)}?${MSG_SELECT}`);
      return toUnified(account, m);
    } catch (err) {
      // Deleted or moved out again before this ran (Outlook ids change when a message moves).
      // Permanent, so skip it rather than stall the checkpoint — see google.ts's same case.
      if (err instanceof GraphHttpError && err.status === 404) return null;
      throw err;
    }
  });
  return {
    messages: fetched.filter((m): m is UnifiedMessage => m !== null),
    historyId: nextLink ?? deltaLink,
  };
}

export async function microsoftGetUnsubscribeInfo(
  account: AccountRow,
  messageId: string
): Promise<UnsubscribeInfo | null> {
  let m: GraphMessage;
  try {
    m = await graphGet<GraphMessage>(
      account,
      `/me/messages/${encodeURIComponent(messageId)}?$select=id,from,internetMessageHeaders`
    );
  } catch {
    return null;
  }
  const headerValue = (name: string) =>
    (m.internetMessageHeaders ?? []).find((h) => h.name?.toLowerCase() === name)?.value ?? "";
  const from = m.from?.emailAddress;
  return {
    from: from ? `${from.name ?? ""} <${from.address ?? ""}>`.trim() : "",
    listUnsubscribe: headerValue("list-unsubscribe"),
    listUnsubscribePost: headerValue("list-unsubscribe-post"),
  };
}

export async function microsoftGetMessage(
  account: AccountRow,
  messageId: string
): Promise<UnifiedMessage | null> {
  try {
    // Outlook stores nearly all mail as HTML. Asking Graph for text makes Exchange do the
    // conversion; htmlToText is the fallback if HTML comes back anyway. A bare tag-strip left
    // <style> blocks and &nbsp; soup that filled the 20k budget before the actual message text.
    const m = await graphGet<GraphMessage>(
      account,
      `/me/messages/${encodeURIComponent(messageId)}?${MSG_SELECT},body,hasAttachments`,
      { Prefer: 'outlook.body-content-type="text"' }
    );
    const unified = toUnified(account, m);
    const raw = m.body?.content ?? "";
    unified.body = (m.body?.contentType?.toLowerCase() === "html" ? htmlToText(raw) : raw).slice(0, 20000);
    // TEMP diagnostic (investigating a reported "email body came back empty" bug, 2026-08-27):
    // remove once root-caused — see docs/superpowers/plans/2026-08-27-whatsapp-session-handover.md.
    if (!unified.body) {
      console.error(
        `microsoft: body extraction returned empty (message ${messageId}, subject "${unified.subject}") — ` +
          `contentType: ${m.body?.contentType ?? "?"}, raw content length: ${raw.length}`
      );
    }
    if (m.hasAttachments) {
      const attachmentData = await graphGet<{ value: GraphAttachment[] }>(
        account,
        `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`
      );
      unified.attachments = attachmentData.value
        .filter((a) => a.name)
        .map((a) => ({
          id: a.id,
          filename: a.name!,
          mimeType: a.contentType ?? "application/octet-stream",
          size: a.size ?? 0,
        }));
    }
    return unified;
  } catch {
    return null;
  }
}

// Returns only the bytes — see googleGetAttachment's comment for why: the caller already has
// filename/mimeType from whichever single fetch it used to resolve this attachment id, so this
// stays consistent with Google's path rather than trusting a second, independently-fetched copy.
export async function microsoftGetAttachment(
  account: AccountRow,
  messageId: string,
  attachmentId: string
): Promise<{ data: Buffer } | null> {
  const data = await graphGet<{ contentBytes?: string }>(
    account,
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  if (!data.contentBytes) {
    console.error(`microsoft: attachments/${attachmentId} returned no contentBytes for message ${messageId}`);
    return null;
  }
  return { data: Buffer.from(data.contentBytes, "base64") };
}

export async function microsoftListEvents(
  account: AccountRow,
  days: number
): Promise<CalendarEvent[]> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const data = await graphGet<{ value: GraphEvent[] }>(
    account,
    `/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${until.toISOString()}` +
      `&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,isAllDay,location,webLink`,
    // UTC is Graph's default too, but pin it so graphDateTimeToIso can rely on it.
    { Prefer: 'outlook.timezone="UTC"' }
  );
  return data.value.map((e) => graphEventToCalendarEvent(account, e));
}

export async function microsoftCreateDraft(
  account: AccountRow,
  to: string,
  subject: string,
  body: string
): Promise<DraftResult> {
  const token = await accessTokenFor(account);
  const res = await graphFetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });
  if (!res.ok) throw new Error(`Graph draft creation returned ${res.status}: ${await res.text()}`);
  const draft = (await res.json()) as { id: string };
  return {
    draftId: draft.id,
    provider: "microsoft",
    accountEmail: account.email,
    reviewNote: `Draft created in Outlook (${account.email}). Review and send it from Outlook — nothing has been sent.`,
  };
}

// The account connected before Mail.Send was requested (see SCOPES) — sending needs a one-time
// reconnect. A distinct type so callers can offer that reconnect instead of a generic failure.
export class OutlookSendPermissionError extends Error {
  constructor(public readonly accountEmail: string) {
    super(`${accountEmail} was connected before Outlook sending was switched on — it needs reconnecting once to send.`);
    this.name = "OutlookSendPermissionError";
  }
}

// /me/sendMail takes file attachments inline only up to 3 MB; bigger ones need an upload session.
const MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/** Actually sends (as opposed to microsoftCreateDraft, which only stages an unsent draft). */
/** Whether this mailbox's Sent Items folder holds at least one email to `address`. */
export async function microsoftHasSentTo(account: AccountRow, address: string): Promise<boolean> {
  const search = encodeURIComponent(`"to:${address.replace(/"/g, "")}"`);
  const data = await graphGet<{ value: { id: string }[] }>(
    account,
    `/me/mailFolders/sentitems/messages?$search=${search}&$top=1&$select=id`
  );
  return data.value.length > 0;
}

export async function microsoftSendMessage(
  account: AccountRow,
  to: string,
  subject: string,
  body: string,
  attachment?: EmailAttachment
): Promise<SendResult> {
  if (attachment && attachment.data.length > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error(`"${attachment.filename}" is over 3 MB — too large to send from Outlook this way.`);
  }
  const token = await accessTokenFor(account);
  const res = await graphFetch(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
        ...(attachment
          ? {
              attachments: [
                {
                  "@odata.type": "#microsoft.graph.fileAttachment",
                  name: attachment.filename,
                  contentType: attachment.mimeType,
                  contentBytes: attachment.data.toString("base64"),
                },
              ],
            }
          : {}),
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    // Graph answers a missing scope with a bare 403 "Access is denied", indistinguishable from any
    // other refusal — so ask the token endpoint what this account was actually granted.
    if (res.status === 403 && !(await hasSendScope(account))) throw new OutlookSendPermissionError(account.email);
    throw new Error(`Graph /me/sendMail returned ${res.status}: ${text}`);
  }
  // sendMail is 202 Accepted with no body — Graph doesn't hand back the sent message's id.
  return { messageId: "", provider: "microsoft", accountEmail: account.email };
}

async function hasSendScope(account: AccountRow): Promise<boolean> {
  try {
    const tokens = await refreshTokens(account);
    return /(^|[\s/])Mail\.Send(\s|$)/i.test(tokens.scope ?? "");
  } catch {
    return true; // can't tell — report the original 403 rather than guess it's the scope
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface GraphChat {
  id: string;
  topic?: string | null;
  chatType?: string;
  webUrl?: string;
  lastMessagePreview?: {
    createdDateTime?: string;
    from?: { user?: { displayName?: string } };
    body?: { content?: string; contentType?: string };
  };
}

export async function microsoftListChats(
  account: AccountRow,
  limit = 20
): Promise<ChatThread[]> {
  const data = await graphGet<{ value: GraphChat[] }>(
    account,
    `/me/chats?$expand=lastMessagePreview&$top=50`
  );
  const threads = data.value
    .filter((c) => c.lastMessagePreview)
    .map((c) => {
      const preview = c.lastMessagePreview!;
      const rawBody = preview.body?.content ?? "";
      return {
        id: c.id,
        accountId: account.id,
        accountEmail: account.email,
        provider: "microsoft" as const,
        topic: c.topic || (c.chatType === "oneOnOne" ? "Direct message" : "Group chat"),
        lastSender: preview.from?.user?.displayName ?? "",
        preview:
          preview.body?.contentType === "html" ? stripHtml(rawBody) : rawBody,
        updatedAt: preview.createdDateTime ?? "",
        link: c.webUrl,
      };
    });
  return threads.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}

interface SearchHit {
  hitId: string;
  resource: {
    id: string;
    chatId?: string;
    createdDateTime?: string;
    from?: { user?: { displayName?: string } };
    body?: { content?: string; contentType?: string };
  };
}

interface SearchResponse {
  value: Array<{
    hitsContainers: Array<{ hits?: SearchHit[] }>;
  }>;
}

export async function microsoftSearchChats(
  account: AccountRow,
  query: string,
  limit = 20
): Promise<ChatThread[]> {
  const data = await graphPost<SearchResponse>(account, "/search/query", {
    requests: [
      {
        entityTypes: ["chatMessage"],
        query: { queryString: query },
        from: 0,
        size: limit,
      },
    ],
  });

  const hits = data.value.flatMap((v) => v.hitsContainers.flatMap((h) => h.hits ?? []));
  return hits.map((hit) => {
    const r = hit.resource;
    const rawBody = r.body?.content ?? "";
    return {
      id: r.id,
      accountId: account.id,
      accountEmail: account.email,
      provider: "microsoft" as const,
      topic: "Teams chat",
      lastSender: r.from?.user?.displayName ?? "",
      preview: r.body?.contentType === "html" ? stripHtml(rawBody) : rawBody,
      updatedAt: r.createdDateTime ?? "",
    };
  });
}

interface GraphDriveItem {
  id: string;
  name?: string;
  file?: { mimeType?: string };
  folder?: object;
  lastModifiedDateTime?: string;
  webUrl?: string;
}

export async function microsoftSearchFiles(
  account: AccountRow,
  query: string,
  limit = 15
): Promise<FileHit[]> {
  const escaped = query.replace(/'/g, "''");
  const data = await graphGet<{ value: GraphDriveItem[] }>(
    account,
    `/me/drive/root/search(q='${encodeURIComponent(escaped)}')` +
      `?$top=${limit}&$select=id,name,file,folder,lastModifiedDateTime,webUrl`
  );
  return data.value.map((item) => ({
    id: item.id,
    accountId: account.id,
    accountEmail: account.email,
    provider: "microsoft" as const,
    name: item.name ?? "(unnamed)",
    mimeType: item.file?.mimeType ?? (item.folder ? "folder" : ""),
    modifiedAt: item.lastModifiedDateTime ?? "",
    link: item.webUrl,
  }));
}

interface GraphDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface GraphEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  start?: GraphDateTime;
  end?: GraphDateTime;
  location?: { displayName?: string };
  webLink?: string;
}

// Graph gives a wall-clock dateTime ("2026-09-15T09:00:00.0000000") plus a separate timeZone, and
// the string alone parses as local time everywhere downstream. A UTC value gets an explicit "Z";
// an all-day event becomes a plain date, matching Google (see services/eventTime.ts). A value in
// any other zone (only an event just created/updated with an explicit zone) is left as-is.
function graphDateTimeToIso(value: GraphDateTime | undefined, allDay: boolean): string {
  const dateTime = value?.dateTime;
  if (!dateTime) return "";
  if (allDay) return dateTime.slice(0, 10);
  if ((value?.timeZone ?? "UTC") !== "UTC" || ZONED_SUFFIX.test(dateTime)) return dateTime;
  const ms = Date.parse(`${dateTime}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : dateTime;
}

const ZONED_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

// Graph's dateTimeTimeZone wants a bare wall-clock time plus a zone name, and doesn't honour an
// offset inside dateTime — "09:00+01:00" tagged UTC landed at 09:00 UTC, an hour late. Google takes
// the offset natively, so the model reasonably sends one. With no explicit zone, resolve the offset
// to the real instant and send it as UTC wall-clock time; an explicit zone means the caller already
// gave local clock time at that place (EventInput's contract) and it passes through untouched.
export function toGraphDateTime(dateTime: string, timeZone: string | undefined): { dateTime: string; timeZone: string } {
  if (timeZone) return { dateTime, timeZone };
  if (ZONED_SUFFIX.test(dateTime)) {
    const ms = Date.parse(dateTime);
    if (Number.isFinite(ms)) return { dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: "UTC" };
  }
  return { dateTime, timeZone: "UTC" };
}

function graphEventToCalendarEvent(account: AccountRow, e: GraphEvent): CalendarEvent {
  const allDay = e.isAllDay === true;
  return {
    id: e.id,
    accountId: account.id,
    accountEmail: account.email,
    provider: "microsoft",
    title: e.subject ?? "(untitled)",
    start: graphDateTimeToIso(e.start, allDay),
    end: graphDateTimeToIso(e.end, allDay),
    ...(allDay ? { allDay: true } : {}),
    location: e.location?.displayName || undefined,
    link: e.webLink,
  };
}

export async function microsoftCreateEvent(
  account: AccountRow,
  input: EventInput
): Promise<CalendarEvent> {
  const event = await graphPost<GraphEvent>(account, "/me/events", {
    subject: input.title,
    location: input.location ? { displayName: input.location } : undefined,
    body: input.description
      ? { contentType: "Text", content: input.description }
      : undefined,
    start: toGraphDateTime(input.start, input.startTimeZone),
    end: toGraphDateTime(input.end, input.endTimeZone),
  });
  return graphEventToCalendarEvent(account, event);
}

export async function microsoftUpdateEvent(
  account: AccountRow,
  eventId: string,
  input: Partial<EventInput>
): Promise<CalendarEvent> {
  const event = await graphPatch<GraphEvent>(account, `/me/events/${encodeURIComponent(eventId)}`, {
    ...(input.title !== undefined ? { subject: input.title } : {}),
    ...(input.location !== undefined ? { location: { displayName: input.location } } : {}),
    ...(input.description !== undefined
      ? { body: { contentType: "Text", content: input.description } }
      : {}),
    ...(input.start !== undefined ? { start: toGraphDateTime(input.start, input.startTimeZone) } : {}),
    ...(input.end !== undefined ? { end: toGraphDateTime(input.end, input.endTimeZone) } : {}),
  });
  return graphEventToCalendarEvent(account, event);
}

export async function microsoftDeleteEvent(account: AccountRow, eventId: string): Promise<void> {
  await graphDelete(account, `/me/events/${encodeURIComponent(eventId)}`);
}

export async function microsoftArchiveMessages(
  account: AccountRow,
  query: string,
  limit = 50
): Promise<number> {
  // Always the inbox, whatever the query says — archiving means "out of the inbox". Searching
  // /me/messages also matched Sent Items and the Archive folder itself, and moved sent mail too.
  const q = { ...toGraphMailQuery(query), folder: "inbox" as const };
  const data = await graphGet<{ value: GraphMessage[] }>(account, graphMessagesPath(q, limit, "$select=id,isRead"));
  const ids = data.value
    .filter((m) => !q.kql || q.unread === undefined || (m.isRead === false) === q.unread)
    .map((m) => m.id)
    .filter(Boolean);
  // Graph throttles bursts of writes per mailbox; one move per message, a few at a time.
  await mapWithConcurrency(ids, 4, (id) =>
    graphPost(account, `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: "archive" })
  );
  return ids.length;
}

export async function microsoftAddCategory(
  account: AccountRow,
  messageId: string,
  category: string
): Promise<void> {
  const current = await graphGet<{ categories?: string[] }>(
    account,
    `/me/messages/${encodeURIComponent(messageId)}?$select=categories`
  );
  const categories = Array.from(new Set([...(current.categories ?? []), category]));
  await graphPatch(account, `/me/messages/${encodeURIComponent(messageId)}`, { categories });
}

interface GraphPerson {
  displayName?: string;
  scoredEmailAddresses?: Array<{ address?: string }>;
}

export async function microsoftSearchContacts(
  account: AccountRow,
  query: string,
  limit = 10
): Promise<ContactHit[]> {
  const data = await graphGet<{ value: GraphPerson[] }>(
    account,
    `/me/people?$search="${encodeURIComponent(query)}"&$top=${limit}`
  );
  const hits: ContactHit[] = [];
  for (const person of data.value) {
    const email = person.scoredEmailAddresses?.[0]?.address;
    if (!email) continue;
    hits.push({
      name: person.displayName || email,
      email,
      provider: "microsoft",
      accountId: account.id,
      accountEmail: account.email,
    });
  }
  return hits.slice(0, limit);
}
