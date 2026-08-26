import { google, gmail_v1 } from "googleapis";
import {
  upsertAccount,
  updateAccountTokens,
  type AccountRow,
} from "../db/store.js";
import type {
  UnifiedMessage,
  CalendarEvent,
  FileHit,
  DraftResult,
  ContactHit,
  EventInput,
  EmailAttachment,
  EmailAttachmentMeta,
  SendResult,
} from "./types.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
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

// loginHint preselects an account on Google's picker (per the WhatsApp registration flow, where
// the user already typed their email in chat) — optional so every existing call site keeps
// working unchanged with it omitted.
export function getGoogleAuthUrl(state: string, loginHint?: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES,
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
}

export interface ExchangedGoogleAuth {
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
}

// Exchanges an OAuth code for tokens + the account's email, with no DB write — shared by both
// the "log into the app" flow (identity only, no data-source row created) and the "connect a
// data source" flow below (which does write a row).
export async function exchangeGoogleCode(code: string): Promise<ExchangedGoogleAuth> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ auth: client, version: "v2" });
  const { data } = await oauth2.userinfo.get();
  if (!data.email) throw new Error("Google did not return an email for this account");

  return {
    email: data.email,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
  };
}

export async function handleGoogleCallback(code: string, ownerId: number): Promise<AccountRow> {
  const auth = await exchangeGoogleCode(code);
  return upsertAccount(ownerId, {
    provider: "google",
    email: auth.email,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiryDate: auth.expiryDate,
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
    updateAccountTokens(account.ownerId, account.id, {
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

/** Walk MIME parts for every part that's a real attachment (has both a filename and an id). */
export function extractAttachmentMetas(
  payload: gmail_v1.Schema$MessagePart | undefined
): EmailAttachmentMeta[] {
  if (!payload) return [];
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    parts.push(p);
    p.parts?.forEach(walk);
  };
  walk(payload);

  return parts
    .filter((p) => p.body?.attachmentId && p.filename)
    .map((p) => ({
      id: p.body!.attachmentId!,
      filename: p.filename!,
      mimeType: p.mimeType ?? "application/octet-stream",
      size: p.body?.size ?? 0,
    }));
}

export async function googleListMessages(
  account: AccountRow,
  opts: { query?: string; limit?: number } = {}
): Promise<UnifiedMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const list = await gmail.users.messages.list({
    userId: "me",
    // Without a search query, "list recent messages" should mean the inbox —
    // Gmail's API otherwise returns messages from the whole mailbox, archived or not.
    q: opts.query ?? "in:inbox",
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
    unified.attachments = extractAttachmentMetas(full.data.payload);
    return unified;
  } catch {
    return null;
  }
}

export async function googleGetAttachment(
  account: AccountRow,
  messageId: string,
  attachmentId: string
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const message = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const metas = extractAttachmentMetas(message.data.payload);
  const meta = metas.find((a) => a.id === attachmentId);
  if (!meta) {
    console.error(
      `google: attachment id ${attachmentId} not found on message ${messageId} — known ids: ` +
        JSON.stringify(metas.map((m) => ({ id: m.id, filename: m.filename })))
    );
    return null;
  }

  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  if (!res.data.data) {
    console.error(
      `google: attachments.get returned no data for ${meta.filename} (message ${messageId}, ` +
        `attachment ${attachmentId}, reported size ${meta.size})`
    );
    return null;
  }
  return { data: Buffer.from(res.data.data, "base64url"), mimeType: meta.mimeType, filename: meta.filename };
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

function eventToCalendarEvent(account: AccountRow, e: {
  id?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  location?: string | null;
  htmlLink?: string | null;
}): CalendarEvent {
  return {
    id: e.id ?? "",
    accountId: account.id,
    accountEmail: account.email,
    provider: "google",
    title: e.summary ?? "(untitled)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? undefined,
    link: e.htmlLink ?? undefined,
  };
}

export async function googleCreateEvent(
  account: AccountRow,
  input: EventInput
): Promise<CalendarEvent> {
  const calendar = google.calendar({ version: "v3", auth: authFor(account) });
  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: input.title,
      location: input.location,
      description: input.description,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
    },
  });
  return eventToCalendarEvent(account, res.data);
}

export async function googleUpdateEvent(
  account: AccountRow,
  eventId: string,
  input: Partial<EventInput>
): Promise<CalendarEvent> {
  const calendar = google.calendar({ version: "v3", auth: authFor(account) });
  const res = await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: {
      ...(input.title !== undefined ? { summary: input.title } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.start !== undefined ? { start: { dateTime: input.start } } : {}),
      ...(input.end !== undefined ? { end: { dateTime: input.end } } : {}),
    },
  });
  return eventToCalendarEvent(account, res.data);
}

export async function googleDeleteEvent(account: AccountRow, eventId: string): Promise<void> {
  const calendar = google.calendar({ version: "v3", auth: authFor(account) });
  await calendar.events.delete({ calendarId: "primary", eventId });
}

export async function googleArchiveMessages(
  account: AccountRow,
  query: string,
  limit = 50
): Promise<number> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const list = await gmail.users.messages.list({ userId: "me", q: query, maxResults: limit });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
  if (!ids.length) return 0;
  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: { ids, removeLabelIds: ["INBOX"] },
  });
  return ids.length;
}

async function findOrCreateLabel(gmail: gmail_v1.Gmail, name: string): Promise<string> {
  const existing = await gmail.users.labels.list({ userId: "me" });
  const match = existing.data.labels?.find(
    (l) => l.name?.toLowerCase() === name.toLowerCase()
  );
  if (match?.id) return match.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  return created.data.id!;
}

export async function googleAddLabel(
  account: AccountRow,
  messageId: string,
  label: string
): Promise<void> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const labelId = await findOrCreateLabel(gmail, label);
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

export async function googleSearchContacts(
  account: AccountRow,
  query: string,
  limit = 10
): Promise<ContactHit[]> {
  const people = google.people({ version: "v1", auth: authFor(account) });
  const res = await people.people.searchContacts({
    query,
    readMask: "names,emailAddresses",
    pageSize: limit,
  });
  const hits: ContactHit[] = [];
  for (const result of res.data.results ?? []) {
    const person = result.person;
    const name = person?.names?.[0]?.displayName ?? "";
    for (const email of person?.emailAddresses ?? []) {
      if (!email.value) continue;
      hits.push({
        name: name || email.value,
        email: email.value,
        provider: "google",
        accountId: account.id,
        accountEmail: account.email,
      });
    }
  }
  return hits.slice(0, limit);
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

// Exported (rather than kept private) so the MIME construction — the part actually worth
// getting right, e.g. the attachment being real multipart rather than inline base64 text —
// can be unit-tested without a live Gmail client.
export function buildRawEmail(
  to: string,
  subject: string,
  body: string,
  attachment?: EmailAttachment
): string {
  if (!attachment) {
    return Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString("base64url");
  }
  const boundary = `marlowe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
    ``,
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
    `Content-Disposition: attachment; filename="${attachment.filename}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    attachment.data.toString("base64"),
    ``,
    `--${boundary}--`,
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

/** Actually sends (as opposed to googleCreateDraft, which only stages an unsent draft). */
export async function googleSendMessage(
  account: AccountRow,
  to: string,
  subject: string,
  body: string,
  attachment?: EmailAttachment
): Promise<SendResult> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const raw = buildRawEmail(to, subject, body, attachment);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return {
    messageId: res.data.id ?? "",
    provider: "google",
    accountEmail: account.email,
  };
}
