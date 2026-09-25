import { google, gmail_v1 } from "googleapis";
import { upsertAccount, updateAccountTokens, type AccountRow } from "../db/store.js";
import { mapWithConcurrency } from "../services/concurrency.js";
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
  UnsubscribeInfo,
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

// Gmail's own sort of bulk mail into tabs — anything outside Primary (CATEGORY_PERSONAL) is
// marketing, social notifications, receipts/updates or mailing lists, never someone writing to
// the user personally. List-Unsubscribe catches the bulk mail that still lands in Primary: every
// marketing platform sets it regardless of how ordinary the From address looks.
const BULK_CATEGORY_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);

function isBulk(msg: gmail_v1.Schema$Message): boolean {
  return (msg.labelIds ?? []).some((l) => BULK_CATEGORY_LABELS.has(l)) || header(msg, "List-Unsubscribe") !== "";
}

// Every metadata-format fetch asks for these — List-Unsubscribe only for isBulk above.
const METADATA_HEADERS = ["Subject", "From", "List-Unsubscribe"];

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
    bulk: isBulk(msg),
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

// Gmail's messages.list returns only ids — there's no way to get subject/from in that same call —
// so every message needs its own messages.get, at 5 quota units each. Capping how many of those
// run at once (rather than firing all of them in one Promise.all) matters because this fan-out
// runs from several independent background checks on the same 5-minute scheduler tick
// (alerts.ts, importantEmailAlerts.ts, reconciliation.ts's 150-message scan) — uncapped, that's
// hundreds of quota units fired in a single instant per account, which is exactly what tripped
// Gmail's "Units per minute per user" quota in production (2026-09-10). This spreads the same
// total cost over time instead.
const GMAIL_GET_CONCURRENCY = 8;

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
  return mapWithConcurrency(ids, GMAIL_GET_CONCURRENCY, async (m) => {
    const full = await gmail.users.messages.get({
      userId: "me",
      id: m.id!,
      format: "metadata",
      metadataHeaders: METADATA_HEADERS,
    });
    return toUnified(account, full.data);
  });
}

function isNotFoundError(err: unknown): boolean {
  const status = (err as { response?: { status?: number }; code?: unknown })?.response?.status;
  return status === 404 || (err as { code?: unknown })?.code === 404;
}

export interface NewMessagesResult {
  messages: UnifiedMessage[];
  // The checkpoint to resume from next time, or null if Gmail didn't report one. Deliberately NOT
  // saved here — see googleListNewMessages's comment.
  historyId: string | null;
}

async function baselineAndList(
  account: AccountRow,
  gmail: gmail_v1.Gmail,
  limit: number
): Promise<NewMessagesResult> {
  // Captured BEFORE the list call, not after — if a message arrives in the gap between this and
  // the list below, the next incremental sync (starting from this id) will pick it up too. That
  // means occasionally re-seeing something the baseline list already returned (harmless — every
  // consumer already dedupes via its own ledger), which is the safe direction to be wrong in;
  // the unsafe direction (a silent gap) is what capturing it after the list would risk.
  const profile = await gmail.users.getProfile({ userId: "me" });
  const messages = await googleListMessages(account, { limit });
  return { messages, historyId: profile.data.historyId ?? null };
}

// Incremental alternative to googleListMessages for "what's new since last time" background
// scans (alerts.ts, importantEmailAlerts.ts, reconciliation.ts — none of which pass a search
// query). Gmail's History API (history.list) returns only what changed since a stored
// checkpoint instead of re-listing and re-fetching the same recent window on every 5-minute
// tick — see the quota-incident comment on GMAIL_GET_CONCURRENCY above; re-fetching an unread
// inbox's top 50-150 messages in full, every tick, forever, is the same waste at a smaller
// scale. Falls back to a full list (and rebaselines) when there's no checkpoint yet (first-ever
// run) or Gmail reports the stored one has expired (history is only retained ~1 week).
//
// Returns the new checkpoint rather than saving it: saving it here (before the messages.get
// fan-out below) meant a failed fetch — e.g. the quota error above — permanently skipped every
// message it had just discovered. hub.ts saves it only once the caller has actually handled them.
export async function googleListNewMessages(
  account: AccountRow,
  opts: { limit?: number } = {}
): Promise<NewMessagesResult> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  if (!account.historyId) {
    return baselineAndList(account, gmail, opts.limit ?? 20);
  }

  const addedIds = new Set<string>();
  let latestHistoryId = account.historyId;
  let pageToken: string | undefined;
  try {
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: account.historyId,
        historyTypes: ["messageAdded"],
        labelId: "INBOX", // mirrors googleListMessages's default in:inbox scope
        pageToken,
      });
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) addedIds.add(added.message.id);
        }
      }
      if (res.data.historyId) latestHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    if (isNotFoundError(err)) {
      return baselineAndList(account, gmail, opts.limit ?? 20);
    }
    throw err;
  }

  if (addedIds.size === 0) return { messages: [], historyId: latestHistoryId };

  const fetched = await mapWithConcurrency([...addedIds], GMAIL_GET_CONCURRENCY, async (id) => {
    try {
      const full = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: METADATA_HEADERS,
      });
      return toUnified(account, full.data);
    } catch (err) {
      // history.list reports what was added to the inbox; anything deleted or moved out again
      // before this fan-out runs 404s here. Unlike the quota failure the checkpoint handling above
      // is built around, that's permanent — and rethrowing stopped hub.ts saving the checkpoint, so
      // the next tick resumed from the same startHistoryId, rediscovered the same dead id and threw
      // identically. That stalled the account's background scans on a 5-minute loop until the id
      // aged out of Gmail's ~1 week history retention. Skip it; the rest of the batch is still good.
      if (isNotFoundError(err)) return null;
      throw err;
    }
  });
  const messages = fetched.filter((m): m is UnifiedMessage => m !== null);
  return { messages, historyId: latestHistoryId };
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
    // TEMP diagnostic (investigating a reported "email body came back empty" bug, 2026-08-27):
    // extractBody has no logging on its own, so a payload shape it doesn't handle fails silently.
    // Remove once that's root-caused — see docs/superpowers/plans/2026-08-27-whatsapp-session-handover.md.
    if (!unified.body && full.data.payload) {
      const shape: { mimeType: string; hasData: boolean; filename: string }[] = [];
      const walk = (p: gmail_v1.Schema$MessagePart) => {
        shape.push({ mimeType: p.mimeType ?? "?", hasData: !!p.body?.data, filename: p.filename ?? "" });
        p.parts?.forEach(walk);
      };
      walk(full.data.payload);
      console.error(
        `google: extractBody returned empty (message ${messageId}, subject "${unified.subject}") — MIME shape:`,
        JSON.stringify(shape)
      );
    }
    return unified;
  } catch {
    return null;
  }
}

export async function googleGetUnsubscribeInfo(
  account: AccountRow,
  messageId: string
): Promise<UnsubscribeInfo | null> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["From", "List-Unsubscribe", "List-Unsubscribe-Post"],
    });
    return {
      from: header(res.data, "From"),
      listUnsubscribe: header(res.data, "List-Unsubscribe"),
      listUnsubscribePost: header(res.data, "List-Unsubscribe-Post"),
    };
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

// Deliberately does NOT re-fetch the message to re-derive/verify the attachment id against a
// fresh extractAttachmentMetas() call, the way this used to. Real incident (2026-08-26): Gmail's
// per-attachment id is not guaranteed stable across two separate messages.get calls for the same
// message — a caller that resolved an id from one fetch (e.g. ingestEmailAttachment, resolving a
// model-shown index) would then have this function's own internal re-fetch mint a *different*
// id for the same physical attachment and reject it as "not found", even though nothing was
// actually wrong. The caller already has the filename/mimeType from whichever single fetch it
// used to resolve this id — passing the id straight through here removes the second fetch (and
// the mismatch it caused) entirely.
export async function googleGetAttachment(
  account: AccountRow,
  messageId: string,
  attachmentId: string
): Promise<{ data: Buffer } | null> {
  const gmail = google.gmail({ version: "v1", auth: authFor(account) });
  const res = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
  if (!res.data.data) {
    console.error(`google: attachments.get returned no data (message ${messageId}, attachment ${attachmentId})`);
    return null;
  }
  return { data: Buffer.from(res.data.data, "base64url") };
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
    ...(!e.start?.dateTime && e.start?.date ? { allDay: true } : {}),
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
    ...(!e.start?.dateTime && e.start?.date ? { allDay: true } : {}),
    location: e.location ?? undefined,
    link: e.htmlLink ?? undefined,
  };
}

// Google Calendar events accept colorId "1".."11" (its 11 predefined event colors). Deriving it
// from accountId (rather than storing a color) keeps every event Marlowe creates on a given
// inbox consistently colored, with no schema change and nothing to keep in sync — see
// client/src/pages/CalendarPage.tsx's swatch, which uses the same `% 11` idea against its own
// palette so the two stay conceptually aligned without sharing code across server/client.
export function colorForAccount(accountId: number): string {
  return String((accountId % 11) + 1);
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
      start: { dateTime: input.start, timeZone: input.startTimeZone },
      end: { dateTime: input.end, timeZone: input.endTimeZone },
      colorId: colorForAccount(account.id),
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
      ...(input.start !== undefined
        ? { start: { dateTime: input.start, timeZone: input.startTimeZone } }
        : {}),
      ...(input.end !== undefined ? { end: { dateTime: input.end, timeZone: input.endTimeZone } } : {}),
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
