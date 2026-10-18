import { google, type calendar_v3 } from "googleapis";
import type { FamilySession } from "./familyDb.js";
import { updateGoogleTokens, type GoogleAccountRow } from "./store.js";

// Joyce's Google Calendar access. Written separately from Marlowe's providers/google.ts for the
// same reason as everything else in this directory: importing it would pull in Marlowe's store
// and app.db. It shares only the Google OAuth *client* (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,
// env vars), the way Joyce's WhatsApp sender shares Marlowe's Meta app token. Tokens live in the
// family's own database, encrypted with the family key.
//
// Calendar only. Marlowe also reads Gmail, Drive and contacts; a family assistant has no use for
// those, and every extra scope is more of someone's account reachable by the whole family.
//   - calendar.events: read and write events.
//   - calendar.calendarlist: see which calendars someone has (and their time zones), and add the
//     family calendar to a member's list so it shows up in their Google Calendar app.
//   - calendar.app.created: create the family calendar (joyce/familyCalendar.ts).
//   - calendar.acls: share it with the other members. Google offers no narrower scope for
//     sharing only the calendars an app created; Joyce only ever touches the family calendar's
//     sharing, never any other calendar's.

const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist",
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.acls",
];

function serverUrl(): string {
  return process.env.SERVER_URL ?? "http://localhost:4000";
}

export function isJoyceGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Its own callback, not Marlowe's /auth/google/callback, so the two products' OAuth round trips
// never pass through one handler. Has to be added to the OAuth client's authorised redirect URIs
// in Google Cloud Console, alongside Marlowe's.
function redirectUri(): string {
  return process.env.JOYCE_GOOGLE_REDIRECT_URI ?? `${serverUrl()}/joyce/google/callback`;
}

function oauthClient() {
  if (!isJoyceGoogleConfigured()) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in the environment");
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

/** The link sent on WhatsApp. It goes to our own server first, which checks it and sets a cookie. */
export function joyceGoogleConnectLink(token: string): string {
  return `${serverUrl()}/joyce/google/connect?t=${encodeURIComponent(token)}`;
}

export function joyceGoogleAuthUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    // consent every time, so Google always hands back a refresh token — without one the
    // connection silently dies an hour later.
    prompt: "consent select_account",
    scope: SCOPES,
    state,
  });
}

export interface ExchangedJoyceGoogleAuth {
  email: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiryDate: number | null;
  timeZone: string;
}

export async function exchangeJoyceGoogleCode(code: string): Promise<ExchangedJoyceGoogleAuth> {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Someone can untick the calendar boxes on Google's consent screen and still finish. Better to
  // say so now than to "connect" an account Joyce can't actually use.
  const granted = new Set((tokens.scope ?? "").split(" "));
  if (tokens.scope && !granted.has("https://www.googleapis.com/auth/calendar.events")) {
    throw new MissingCalendarPermission();
  }

  const { data: user } = await google.oauth2({ auth: client, version: "v2" }).userinfo.get();
  if (!user.email) throw new Error("Google did not return an email for this account");

  const { data: primary } = await google
    .calendar({ version: "v3", auth: client })
    .calendarList.get({ calendarId: "primary" });

  return {
    email: user.email,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
    timeZone: primary.timeZone || "UTC",
  };
}

export class MissingCalendarPermission extends Error {
  constructor() {
    super("Calendar permission was not granted on Google's consent screen");
    this.name = "MissingCalendarPermission";
  }
}

/** Best effort: tells Google to drop the grant, so a disconnected account really is disconnected. */
export async function revokeJoyceGoogleToken(account: GoogleAccountRow): Promise<void> {
  const token = account.refreshToken ?? account.accessToken;
  if (!token) return;
  await oauthClient().revokeToken(token);
}

function calendarFor(session: FamilySession, account: GoogleAccountRow): calendar_v3.Calendar {
  const client = oauthClient();
  client.setCredentials({
    access_token: account.accessToken ?? undefined,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiryDate ?? undefined,
  });
  client.on("tokens", (tokens) => {
    try {
      updateGoogleTokens(session, account.id, {
        accessToken: tokens.access_token ?? account.accessToken,
        refreshToken: tokens.refresh_token ?? undefined,
        expiryDate: tokens.expiry_date ?? account.expiryDate,
      });
    } catch (err) {
      // The family's connection can be closed by the LRU in familyDb.ts while a Google call is
      // in flight. Losing the refreshed token only costs a refresh next time.
      console.error("joyce: couldn't store refreshed Google tokens", err);
    }
  });
  return google.calendar({ version: "v3", auth: client });
}

// --- Event references ---------------------------------------------------------------------------
//
// The model refers to an event by a ref it was handed by list_calendar_events. The account part
// is an id in *this family's* google_accounts table, looked up through the session, so a ref
// made up or copied from anywhere else finds no account rather than someone else's. The calendar
// and event ids are then only meaningful to that member's own Google account.

export function makeEventRef(accountId: number, calendarId: string, eventId: string): string {
  return `${accountId}|${calendarId}|${eventId}`;
}

export function parseEventRef(
  ref: string
): { accountId: number; calendarId: string; eventId: string } | null {
  const parts = ref.split("|");
  if (parts.length !== 3) return null;
  const accountId = Number(parts[0]);
  if (!Number.isInteger(accountId) || !parts[1] || !parts[2]) return null;
  return { accountId, calendarId: parts[1], eventId: parts[2] };
}

// --- Time zones ---------------------------------------------------------------------------------

/** How far `timeZone` is ahead of UTC at a given instant, in ms. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant midnight starts on `date` (YYYY-MM-DD) in `timeZone`. */
export function startOfDayIn(date: string, timeZone: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  // Re-check once at the answer, in case a clock change falls between the guess and the answer.
  const corrected = naive - zoneOffsetMs(utc, timeZone);
  if (corrected !== utc) utc = corrected;
  return new Date(utc);
}

/** "Mon 20 Oct, 15:04" — the current time as a family member's calendar sees it. */
export function nowIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function addHourLocal(dateTime: string): string {
  const withSeconds = dateTime.length === 16 ? `${dateTime}:00` : dateTime;
  return new Date(Date.parse(`${withSeconds}Z`) + 3_600_000).toISOString().slice(0, 19);
}

/**
 * Turns the model's start/end into Google's shape. A bare date means all day; a date and time
 * with no offset is local to the calendar's own time zone, which is the whole point: "3pm" means
 * 3pm where that family member's calendar lives, whatever the server's clock says.
 */
export function eventTimes(
  start: string,
  end: string | undefined,
  timeZone: string
): { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime } | string {
  if (DATE_ONLY.test(start)) {
    // Google's all-day end date is exclusive: a one-day event on the 20th ends on the 21st.
    if (end !== undefined && !DATE_ONLY.test(end)) return "An all-day event's end must also be a date (YYYY-MM-DD).";
    const endDate = end ? addDays(end, 1) : addDays(start, 1);
    if (endDate <= start) return "The end date is before the start date.";
    return { start: { date: start }, end: { date: endDate } };
  }
  if (!LOCAL_DATE_TIME.test(start)) {
    return "Times must look like 2026-10-20T15:00 (local to the calendar), or 2026-10-20 for all day.";
  }
  if (end !== undefined && !LOCAL_DATE_TIME.test(end)) {
    return "The end time must look like 2026-10-20T16:00, in the same form as the start.";
  }
  const endTime = end ?? addHourLocal(start);
  if (endTime <= start) return "The end time is before the start time.";
  return {
    start: { dateTime: start, timeZone },
    end: { dateTime: endTime, timeZone },
  };
}

// --- Reading and writing -----------------------------------------------------------------------

export interface MemberCalendar {
  id: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
}

/**
 * The calendars this member shows in Google Calendar — their own plus any shared with them (a
 * "Family" calendar, a partner's) — rather than every calendar they've ever subscribed to.
 */
export async function listMemberCalendars(
  session: FamilySession,
  account: GoogleAccountRow,
  /** The family calendar, which is listed once for everyone rather than under each member. */
  excludeCalendarId?: string
): Promise<MemberCalendar[]> {
  const res = await calendarFor(session, account).calendarList.list({ maxResults: 50 });
  return (res.data.items ?? [])
    .filter((c) => c.id && c.id !== excludeCalendarId && (c.primary || c.selected) && !c.deleted && !c.hidden)
    .map((c) => ({
      id: c.id!,
      name: c.primary ? "their main calendar" : c.summaryOverride || c.summary || c.id!,
      primary: !!c.primary,
      canWrite: c.accessRole === "owner" || c.accessRole === "writer",
    }));
}

export interface FamilyCalendarEvent {
  ref: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  calendarName: string;
}

const MAX_CALENDARS_PER_MEMBER = 10;

/**
 * Events on one calendar from `from` to `to` inclusive (YYYY-MM-DD), read through `account` and
 * reported in `timeZone`.
 */
export async function listCalendarEvents(
  session: FamilySession,
  account: GoogleAccountRow,
  calendar: { id: string; name: string },
  from: string,
  to: string,
  timeZone: string
): Promise<FamilyCalendarEvent[]> {
  const res = await calendarFor(session, account).events.list({
    calendarId: calendar.id,
    timeMin: startOfDayIn(from, timeZone).toISOString(),
    timeMax: startOfDayIn(addDays(to, 1), timeZone).toISOString(),
    timeZone,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  return (res.data.items ?? [])
    .filter((e) => e.id && e.status !== "cancelled")
    .map((e) => ({
      ref: makeEventRef(account.id, calendar.id, e.id!),
      title: e.summary ?? "(untitled)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      allDay: !e.start?.dateTime,
      location: e.location ?? null,
      calendarName: calendar.name,
    }));
}

/** Everything on a member's own calendars from `from` to `to`, in their own time zone. */
export async function listMemberEvents(
  session: FamilySession,
  account: GoogleAccountRow,
  from: string,
  to: string,
  excludeCalendarId?: string
): Promise<FamilyCalendarEvent[]> {
  const calendars = (await listMemberCalendars(session, account, excludeCalendarId)).slice(
    0,
    MAX_CALENDARS_PER_MEMBER
  );
  const perCalendar = await Promise.all(
    calendars.map((cal) => listCalendarEvents(session, account, cal, from, to, account.timeZone))
  );
  return perCalendar.flat().sort((a, b) => a.start.localeCompare(b.start));
}

// --- The family calendar (see joyce/familyCalendar.ts for when these are used) ------------------

/** Creates a new calendar in this member's Google account, owned by them. Returns its id. */
export async function createGoogleCalendar(
  session: FamilySession,
  account: GoogleAccountRow,
  name: string
): Promise<string> {
  const res = await calendarFor(session, account).calendars.insert({
    requestBody: {
      summary: name,
      description: "Shared family calendar, kept by Joyce.",
      timeZone: account.timeZone,
    },
  });
  if (!res.data.id) throw new Error("Google created the calendar but returned no id");
  return res.data.id;
}

/**
 * Gives `email` edit access to a calendar `owner` owns. No email from Google: Joyce tells them
 * herself, and adds it to their list with addCalendarToList. Repeating it is harmless.
 */
export async function shareGoogleCalendar(
  session: FamilySession,
  owner: GoogleAccountRow,
  calendarId: string,
  email: string
): Promise<void> {
  await calendarFor(session, owner).acl.insert({
    calendarId,
    sendNotifications: false,
    requestBody: { role: "writer", scope: { type: "user", value: email } },
  });
}

export async function unshareGoogleCalendar(
  session: FamilySession,
  owner: GoogleAccountRow,
  calendarId: string,
  email: string
): Promise<void> {
  await calendarFor(session, owner).acl.delete({ calendarId, ruleId: `user:${email}` });
}

/** Puts a calendar shared with this member into their Google Calendar app's list. */
export async function addCalendarToList(
  session: FamilySession,
  account: GoogleAccountRow,
  calendarId: string
): Promise<void> {
  try {
    await calendarFor(session, account).calendarList.insert({ requestBody: { id: calendarId } });
  } catch (err) {
    // Already in their list — that's the outcome we wanted.
    if ((err as { response?: { status?: number } }).response?.status === 409) return;
    throw err;
  }
}

export async function createMemberEvent(
  session: FamilySession,
  account: GoogleAccountRow,
  calendarId: string,
  event: {
    title: string;
    times: { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime };
    location?: string;
    description?: string;
  }
): Promise<{ ref: string; start: string; end: string }> {
  const res = await calendarFor(session, account).events.insert({
    calendarId,
    requestBody: {
      summary: event.title,
      location: event.location,
      description: event.description,
      ...event.times,
    },
  });
  return {
    ref: makeEventRef(account.id, calendarId, res.data.id ?? ""),
    start: res.data.start?.dateTime ?? res.data.start?.date ?? "",
    end: res.data.end?.dateTime ?? res.data.end?.date ?? "",
  };
}

export async function updateMemberEvent(
  session: FamilySession,
  account: GoogleAccountRow,
  calendarId: string,
  eventId: string,
  changes: {
    title?: string;
    location?: string;
    times?: { start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime };
  }
): Promise<{ title: string; start: string; end: string }> {
  const res = await calendarFor(session, account).events.patch({
    calendarId,
    eventId,
    requestBody: {
      ...(changes.title !== undefined ? { summary: changes.title } : {}),
      ...(changes.location !== undefined ? { location: changes.location } : {}),
      ...(changes.times ?? {}),
    },
  });
  return {
    title: res.data.summary ?? "(untitled)",
    start: res.data.start?.dateTime ?? res.data.start?.date ?? "",
    end: res.data.end?.dateTime ?? res.data.end?.date ?? "",
  };
}

/** The event as it stands, so a change to only the start can keep the event's length. */
export async function getMemberEvent(
  session: FamilySession,
  account: GoogleAccountRow,
  calendarId: string,
  eventId: string,
  timeZone = account.timeZone
): Promise<calendar_v3.Schema$Event> {
  const res = await calendarFor(session, account).events.get({ calendarId, eventId, timeZone });
  return res.data;
}

export async function deleteMemberEvent(
  session: FamilySession,
  account: GoogleAccountRow,
  calendarId: string,
  eventId: string
): Promise<void> {
  await calendarFor(session, account).events.delete({ calendarId, eventId });
}

/**
 * Plain-English reason a Google call failed, for the model to pass on. The common real cases are
 * someone revoking Joyce in their Google settings (invalid_grant) and a shared calendar they can
 * only view.
 */
export function describeGoogleError(err: unknown, account: GoogleAccountRow): string {
  const who = account.memberName ?? "that person";
  const e = err as { message?: string; code?: number | string; response?: { status?: number } };
  const status = e.response?.status ?? (typeof e.code === "number" ? e.code : undefined);
  const message = e.message ?? "";
  if (message.includes("invalid_grant") || status === 401) {
    return (
      `${who}'s Google Calendar connection has stopped working (access was removed or expired). ` +
      `${who} can say "connect my Google Calendar" to set it up again.`
    );
  }
  if (status === 403) return `${who}'s Google account doesn't allow that change on this calendar.`;
  if (status === 404 || status === 410) return "That event no longer exists. List the calendar again.";
  return "Google Calendar returned an error. Tell the user it didn't work and to try again shortly.";
}
