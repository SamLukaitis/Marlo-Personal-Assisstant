import { google, gmail_v1 } from "googleapis";
import {
  upsertAccount,
  updateAccountTokens,
  type AccountRow,
} from "../db/store.js";
import type { UnifiedMessage, CalendarEvent, FileHit, DraftResult } from "./types.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function createOAuthClient() {
  if (!isGoogleConfigured()) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in the environment");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/auth/google/callback"
  );
}

export function getGoogleAuthUrl(): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES,
  });
}

export async function handleGoogleCallback(code: string): Promise<AccountRow> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data } = await oauth2.userinfo.get();
  if (!data.email) throw new Error("Google did not return an email for this account");

  return upsertAccount({
    provider: "google",
    email: data.email,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
  });
}

/** Authenticated client for a stored account; persists refreshed tokens. */
function authFor(account: AccountRow) {
  const client = createOAuthClient();
  client.setCredentials({
    access_token: account.accessToken ?? undefined,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiryDate ?? undefined,
  });
  client.on("tokens", (tokens) => {
    updateAccountTokens(account.id, {
      accessToken: tokens.access_token ?? account.accessToken,
      refreshToken: tokens.refresh_token ?? undefined,
      expiryDate: tokens.expiry_date ?? account.expiryDate,
    });
  });
  return client;
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return (
    msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ""
  );
}

function toUnified(account: AccountRow, msg: gmail_v1.Schema$Message): UnifiedMessage {
  return {
    id: msg.id!,
    accountId: account.id,
    accountEmail: account.email,
    provider: "google",
    subject: header(msg, "Subject") || "(no subject)",
    from: header(msg, "From"),
    snippet: msg.snippet ?? "",
    receivedAt: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
    unread: (msg.labelIds ?? []).includes("UNREAD"),
    link: `https://mail.google.com/mail/u/${account.email}/#all/${msg.id}`,
  };
}

/** Walk MIME parts for the first text/plain (fallback text/html) body. */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) =>
    data ? Buffer.from(data, "base64url").toString("utf-8") : "";

  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(payload);

  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain.body!.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html) return decode(html.body!.data).replace(/<[^>]+>/g, " ");
  return "";
}

export async function googleListMessages(
  account: AccountRow,
  opts: { query?: string; limit?: number } = {}
): Promise<UnifiedMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const list = await gmail.users.messages.list({
    userId: "me",
    q: opts.query,
    maxResults: opts.limit ?? 20,
  });
  const ids = list.data.messages ?? [];
  return Promise.all(
    ids.map(async (m) => {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: m.id!,
        format: "metadata",
        metadataHeaders: ["Subject", "From"],
      });
      return toUnified(account, full.data);
    })
  );
}

export async function googleGetMessage(
  account: AccountRow,
  messageId: string
): Promise<UnifiedMessage | null> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  try {
    const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const unified = toUnified(account, full.data);
    unified.body = extractBody(full.data.payload).slice(0, 20000);
    return unified;
  } catch {
    return null;
  }
}

export async function googleListEvents(
  account: AccountRow,
  days: number
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: authFor(account) });
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items ?? []).map((e) => ({
    id: e.id ?? "",
    accountId: account.id,
    accountEmail: account.email,
    provider: "google" as const,
    title: e.summary ?? "(untitled)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? undefined,
    link: e.htmlLink ?? undefined,
  }));
}

export async function googleSearchFiles(
  account: AccountRow,
  query: string,
  limit = 15
): Promise<FileHit[]> {
  const drive = google.drive({ version: "v3", auth: authFor(account) });
  const escaped = query.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
    pageSize: limit,
    fields: "files(id, name, mimeType, modifiedTime, webViewLink)",
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    accountId: account.id,
    accountEmail: account.email,
    provider: "google" as const,
    name: f.name ?? "(unnamed)",
    mimeType: f.mimeType ?? "",
    modifiedAt: f.modifiedTime ?? "",
    link: f.webViewLink ?? undefined,
  }));
}

export async function googleCreateDraft(
  account: AccountRow,
  to: string,
  subject: string,
  body: string
): Promise<DraftResult> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString("base64url");
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw } },
  });
  return {
    draftId: res.data.id ?? "",
    provider: "google",
    accountEmail: account.email,
    reviewNote: `Draft created in Gmail (${account.email}). Review and send it from Gmail — nothing has been sent.`,
  };
}
