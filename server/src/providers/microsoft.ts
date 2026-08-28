import {
  upsertAccount,
  updateAccountTokens,
  type AccountRow,
} from "../db/store.js";
import type {
  UnifiedMessage,
  CalendarEvent,
  DraftResult,
  FileHit,
  ChatThread,
  ContactHit,
  EventInput,
} from "./types.js";

const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES =
  "offline_access User.Read Mail.Read Mail.ReadWrite Calendars.ReadWrite Chat.Read Files.Read People.Read";

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
  email: string;
  accessToken: string;
  refreshToken: string | null;
  expiryDate: number;
}

// Exchanges an OAuth code for tokens + the account's email, with no DB write — shared by both
// the "log into the app" flow (identity only) and the "connect a data source" flow below.
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
  const profile = (await profileRes.json()) as { mail?: string; userPrincipalName?: string };
  const email = profile.mail ?? profile.userPrincipalName;
  if (!email) throw new Error("Microsoft did not return an email for this account");

  return {
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: Date.now() + tokens.expires_in * 1000,
  };
}

export async function handleMicrosoftCallback(code: string, ownerId: number): Promise<AccountRow> {
  const auth = await exchangeMicrosoftCode(code);
  return upsertAccount(ownerId, {
    provider: "microsoft",
    email: auth.email,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiryDate: auth.expiryDate,
  });
}

/** Returns a valid access token, refreshing (and persisting) if near expiry. */
async function accessTokenFor(account: AccountRow): Promise<string> {
  const stillValid =
    account.accessToken && account.expiryDate && account.expiryDate > Date.now() + 60_000;
  if (stillValid) return account.accessToken!;

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
  return tokens.access_token;
}

async function graphGet<T>(account: AccountRow, path: string): Promise<T> {
  const token = await accessTokenFor(account);
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function graphPost<T>(account: AccountRow, path: string, body: unknown): Promise<T> {
  const token = await accessTokenFor(account);
  const res = await fetch(`${GRAPH}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function graphPatch<T>(account: AccountRow, path: string, body: unknown): Promise<T> {
  const token = await accessTokenFor(account);
  const res = await fetch(`${GRAPH}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Graph ${path} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function graphDelete(account: AccountRow, path: string): Promise<void> {
  const token = await accessTokenFor(account);
  const res = await fetch(`${GRAPH}${path}`, {
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
    link: m.webLink,
  };
}

const MSG_SELECT = "$select=id,subject,from,bodyPreview,receivedDateTime,isRead,webLink";

export async function microsoftListMessages(
  account: AccountRow,
  opts: { query?: string; limit?: number } = {}
): Promise<UnifiedMessage[]> {
  const top = `$top=${opts.limit ?? 20}`;
  // Without a search query, "list recent messages" should mean the inbox —
  // /me/messages otherwise returns messages from every folder, archived or not.
  const path = opts.query
    ? `/me/messages?$search="${encodeURIComponent(opts.query)}"&${top}&${MSG_SELECT}`
    : `/me/mailFolders/inbox/messages?$orderby=receivedDateTime desc&${top}&${MSG_SELECT}`;
  const data = await graphGet<{ value: GraphMessage[] }>(account, path);
  return data.value.map((m) => toUnified(account, m));
}

export async function microsoftGetMessage(
  account: AccountRow,
  messageId: string
): Promise<UnifiedMessage | null> {
  try {
    const m = await graphGet<GraphMessage>(
      account,
      `/me/messages/${encodeURIComponent(messageId)}?${MSG_SELECT},body,hasAttachments`
    );
    const unified = toUnified(account, m);
    const raw = m.body?.content ?? "";
    unified.body = (m.body?.contentType === "html" ? raw.replace(/<[^>]+>/g, " ") : raw).slice(
      0,
      20000
    );
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
  const data = await graphGet<{
    value: Array<{
      id: string;
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      location?: { displayName?: string };
      webLink?: string;
    }>;
  }>(
    account,
    `/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${until.toISOString()}` +
      `&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,location,webLink`
  );
  return data.value.map((e) => ({
    id: e.id,
    accountId: account.id,
    accountEmail: account.email,
    provider: "microsoft" as const,
    title: e.subject ?? "(untitled)",
    start: e.start?.dateTime ?? "",
    end: e.end?.dateTime ?? "",
    location: e.location?.displayName || undefined,
    link: e.webLink,
  }));
}

export async function microsoftCreateDraft(
  account: AccountRow,
  to: string,
  subject: string,
  body: string
): Promise<DraftResult> {
  const token = await accessTokenFor(account);
  const res = await fetch(`${GRAPH}/me/messages`, {
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

interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  location?: { displayName?: string };
  webLink?: string;
}

function graphEventToCalendarEvent(account: AccountRow, e: GraphEvent): CalendarEvent {
  return {
    id: e.id,
    accountId: account.id,
    accountEmail: account.email,
    provider: "microsoft",
    title: e.subject ?? "(untitled)",
    start: e.start?.dateTime ?? "",
    end: e.end?.dateTime ?? "",
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
    start: { dateTime: input.start, timeZone: "UTC" },
    end: { dateTime: input.end, timeZone: "UTC" },
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
    ...(input.start !== undefined ? { start: { dateTime: input.start, timeZone: "UTC" } } : {}),
    ...(input.end !== undefined ? { end: { dateTime: input.end, timeZone: "UTC" } } : {}),
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
  const data = await graphGet<{ value: GraphMessage[] }>(
    account,
    `/me/messages?$search="${encodeURIComponent(query)}"&$top=${limit}&$select=id`
  );
  const ids = data.value.map((m) => m.id).filter(Boolean);
  await Promise.all(
    ids.map((id) => graphPost(account, `/me/messages/${encodeURIComponent(id)}/move`, {
      destinationId: "archive",
    }))
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
