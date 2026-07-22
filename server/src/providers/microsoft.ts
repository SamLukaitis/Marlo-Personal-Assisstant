import {
  upsertAccount,
  updateAccountTokens,
  type AccountRow,
} from "../db/store.js";
import type { UnifiedMessage, CalendarEvent, DraftResult } from "./types.js";

const AUTH_BASE = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access User.Read Mail.Read Mail.ReadWrite Calendars.Read";

export function isMicrosoftConfigured(): boolean {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

function redirectUri(): string {
  return process.env.MS_REDIRECT_URI ?? "http://localhost:4000/auth/microsoft/callback";
}

export function getMicrosoftAuthUrl(): string {
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

export async function handleMicrosoftCallback(code: string): Promise<AccountRow> {
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

  return upsertAccount({
    provider: "microsoft",
    email,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: Date.now() + tokens.expires_in * 1000,
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
  updateAccountTokens(account.id, {
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

interface GraphMessage {
  id: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  webLink?: string;
  body?: { content?: string; contentType?: string };
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
  const path = opts.query
    ? `/me/messages?$search="${encodeURIComponent(opts.query)}"&${top}&${MSG_SELECT}`
    : `/me/messages?$orderby=receivedDateTime desc&${top}&${MSG_SELECT}`;
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
      `/me/messages/${encodeURIComponent(messageId)}?${MSG_SELECT},body`
    );
    const unified = toUnified(account, m);
    const raw = m.body?.content ?? "";
    unified.body = (m.body?.contentType === "html" ? raw.replace(/<[^>]+>/g, " ") : raw).slice(
      0,
      20000
    );
    return unified;
  } catch {
    return null;
  }
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
