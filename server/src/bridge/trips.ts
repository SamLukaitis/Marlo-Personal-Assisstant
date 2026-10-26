// Trips and availability across the link. A person's trips are worked out from their bookings
// (services/tripDerivation.ts) and, if they allow it, written into the family's own file as dates
// and, only if they chose, a country. Availability is the other direction: Joyce asks and gets back
// only which days clash.
//
// Like the rest of the bridge, nothing here takes a family or a member: the family is whoever the
// person's own phone belongs to, and only a phone that consented to the link gets any of it.
import { DateTime } from "luxon";
import {
  getFamilyLink,
  getFamilyTrip,
  listFamilyShares,
  listFamilyTrips,
  listPhoneNumbersForUser,
  logFamilyShare,
  markFamilyShareRemoved,
  createPendingAction,
  deleteFamilyTrip,
  deleteFamilyTrips,
  normalizePhone,
  resolveOwnerByPhone,
  saveFamilyTrip,
  type FamilyTripRow,
} from "../db/store.js";
import { sendProactiveMessageWithButtons } from "../services/outbound.js";
import { computeAvailability, rangeInstants } from "../services/availability.js";
import { hubListEventsBetween } from "../services/hub.js";
import { countryFor, tripsForOwner } from "../services/tripDerivation.js";
import { userLocalClock } from "../services/userTimezone.js";
import { findFamilyForPhone } from "../joyce/registry.js";
import { openFamilySessionForPhone, type FamilySession } from "../joyce/familyDb.js";
import {
  clearMemberTripCountries,
  deleteAllMemberTrips,
  deleteMemberTrip,
  saveMemberTrip,
  updateMemberTrip,
} from "../joyce/trips.js";
import type { AvailabilityAnswer } from "../joyce/hooks.js";

const TRIP_ASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TripChoice = "dates" | "country" | "no";

function shortDate(date: string): string {
  return DateTime.fromISO(date).toFormat("d LLL");
}

function span(start: string, end: string): string {
  return start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`;
}

/** The family session for a phone that is in a family and has consented to the link. */
function linkedSession(ownerId: number, phone: string): FamilySession | null {
  const normalized = normalizePhone(phone);
  if (!findFamilyForPhone(normalized)) return null;
  if (!getFamilyLink(ownerId, normalized)) return null;
  return openFamilySessionForPhone(normalized);
}

/** Writes or updates the trip in the family's file and the audit log. Returns the Joyce row id. */
function writeTrip(
  ownerId: number,
  phone: string,
  session: FamilySession,
  trip: { startDate: string; endDate: string },
  country: string | null,
  existingJoyceId: number | null
): number {
  const payload = { startDate: trip.startDate, endDate: trip.endDate, country };
  if (existingJoyceId !== null && updateMemberTrip(session, existingJoyceId, payload)) {
    // The log keeps the dates only, and always the current ones.
    markFamilyShareRemoved(ownerId, phone, "trip", existingJoyceId);
    logFamilyShare(ownerId, phone, "trip", span(trip.startDate, trip.endDate), existingJoyceId);
    return existingJoyceId;
  }
  const id = saveMemberTrip(session, payload);
  logFamilyShare(ownerId, phone, "trip", span(trip.startDate, trip.endDate), id);
  return id;
}

function takeBack(ownerId: number, phone: string, session: FamilySession | null, row: FamilyTripRow): void {
  if (row.joyceTripId === null) return;
  if (session) deleteMemberTrip(session, row.joyceTripId);
  markFamilyShareRemoved(ownerId, phone, "trip", row.joyceTripId);
}

function shareTrip(
  ownerId: number,
  phone: string,
  session: FamilySession,
  row: FamilyTripRow,
  includeCountry: boolean
): FamilyTripRow {
  const joyceTripId = writeTrip(
    ownerId,
    phone,
    session,
    row,
    includeCountry ? row.country : null,
    row.joyceTripId
  );
  const next: FamilyTripRow = { ...row, state: "shared", shareCountry: includeCountry, joyceTripId };
  saveFamilyTrip(ownerId, phone, next);
  return next;
}

async function askAboutTrip(ownerId: number, phone: string, row: FamilyTripRow): Promise<void> {
  const where = row.country ? ` (${row.country})` : "";
  const text =
    `I found a trip: *${span(row.startDate, row.endDate)}*${where}. Want your family to see when you're away? ` +
    "I'd only share the dates, and the country if you say so. Never where exactly, or anything about the booking.";
  const typed =
    `${text}\n\nReply "share dates"${row.country ? ', "share dates and country"' : ""} or "don't share".`;
  const actionId = createPendingAction(
    ownerId,
    "trip_share",
    "Share this trip with the family?",
    JSON.stringify({ phone: normalizePhone(phone), tripKey: row.tripKey, startDate: row.startDate, endDate: row.endDate }),
    TRIP_ASK_TTL_MS
  );
  const buttons = [
    { id: `pa:${actionId}:dates`, title: "Share dates" },
    ...(row.country ? [{ id: `pa:${actionId}:country`, title: "Dates + country" }] : []),
    { id: `pa:${actionId}:no`, title: "Don't share" },
  ];
  await sendProactiveMessageWithButtons(
    normalizePhone(phone),
    text,
    buttons,
    "alert",
    `[Asked whether to share trip ${row.startDate} to ${row.endDate} (trip ${row.tripKey}) with the family. If they answer in words, call answer_trip_question.]`,
    typed
  );
}

const syncing = new Set<string>();

async function syncForPhone(ownerId: number, phone: string): Promise<void> {
  const normalized = normalizePhone(phone);
  const link = getFamilyLink(ownerId, normalized);
  if (!link || link.tripsMode === "off") return;
  const session = linkedSession(ownerId, normalized);
  if (!session) return;

  const derived = tripsForOwner(ownerId, userLocalClock(ownerId).dateKey);
  const known = new Map(listFamilyTrips(ownerId, normalized).map((r) => [r.tripKey, r]));
  const stillThere = new Set(derived.map((t) => t.key));

  // A trip that's over or whose bookings are gone comes down.
  for (const row of known.values()) {
    if (stillThere.has(row.tripKey)) continue;
    takeBack(ownerId, normalized, session, row);
    deleteFamilyTrip(ownerId, normalized, row.tripKey);
  }

  for (const trip of derived) {
    const row = known.get(trip.key);
    const changed = !!row && (row.startDate !== trip.startDate || row.endDate !== trip.endDate);
    if (row && !changed) {
      // Shared stays shared and declined stays declined (in automatic mode too). A question still
      // waiting is left alone in ask mode; in automatic mode it falls through and is shared.
      if (row.state === "shared" || row.state === "declined") continue;
      if (row.state === "asked" && link.tripsMode === "ask") continue;
    }

    const country = row && !changed && row.country ? row.country : await countryFor(ownerId, trip.destination);
    const fresh: FamilyTripRow = {
      tripKey: trip.key,
      startDate: trip.startDate,
      endDate: trip.endDate,
      country,
      state: row?.state ?? "asked",
      shareCountry: row?.shareCountry ?? null,
      joyceTripId: row?.joyceTripId ?? null,
    };
    if (link.tripsMode === "auto") {
      shareTrip(ownerId, normalized, session, fresh, link.tripsCountry && country !== null);
      continue;
    }
    // Ask mode, a new trip or one whose dates moved: what's already shared stays until they answer.
    const asking: FamilyTripRow = { ...fresh, state: "asked", shareCountry: null };
    saveFamilyTrip(ownerId, normalized, asking);
    await askAboutTrip(ownerId, normalized, asking);
  }
}

/** Looks at one person's bookings and shares or asks about trips as their settings say. */
export async function syncTripsForPhone(ownerId: number, phone: string): Promise<void> {
  const key = `${ownerId}:${normalizePhone(phone)}`;
  if (syncing.has(key)) return;
  syncing.add(key);
  try {
    await syncForPhone(ownerId, phone);
  } finally {
    syncing.delete(key);
  }
}

/** Every phone of this person that has consented to the link. */
export async function syncTripsForOwner(ownerId: number): Promise<void> {
  for (const p of listPhoneNumbersForUser(ownerId)) {
    if (!getFamilyLink(ownerId, p.phone)) continue;
    await syncTripsForPhone(ownerId, p.phone);
  }
}

export type AnswerResult =
  | { ok: true; shared: boolean; country: string | null; startDate: string; endDate: string }
  | { ok: false; reason: "not_linked" | "gone" | "answered" | "stale" };

/**
 * Applies the person's answer to a trip question. `asked` is the dates the question named: an
 * answer to a question whose dates have since moved is refused, because they agreed to something else.
 */
export function answerTripQuestion(
  ownerId: number,
  phone: string,
  tripKey: string,
  choice: TripChoice,
  asked?: { startDate: string; endDate: string }
): AnswerResult {
  const normalized = normalizePhone(phone);
  const session = linkedSession(ownerId, normalized);
  if (!session) return { ok: false, reason: "not_linked" };
  const row = getFamilyTrip(ownerId, normalized, tripKey);
  if (!row) return { ok: false, reason: "gone" };
  if (row.state !== "asked") return { ok: false, reason: "answered" };
  if (asked && (asked.startDate !== row.startDate || asked.endDate !== row.endDate)) {
    return { ok: false, reason: "stale" };
  }
  if (choice === "no") {
    takeBack(ownerId, normalized, session, row);
    saveFamilyTrip(ownerId, normalized, { ...row, state: "declined", shareCountry: false, joyceTripId: null });
    return { ok: true, shared: false, country: null, startDate: row.startDate, endDate: row.endDate };
  }
  const withCountry = choice === "country" && row.country !== null;
  shareTrip(ownerId, normalized, session, row, withCountry);
  return {
    ok: true,
    shared: true,
    country: withCountry ? row.country : null,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

/** Trips waiting on an answer, for someone who replies in words. */
export function openTripQuestions(ownerId: number, phone: string): FamilyTripRow[] {
  return listFamilyTrips(ownerId, phone).filter((r) => r.state === "asked");
}

/** Takes every shared trip out of the family's file and forgets what was decided about each. */
export function removeSharedTrips(ownerId: number, phone: string, session: FamilySession | null): number {
  const normalized = normalizePhone(phone);
  let removed = 0;
  if (session) removed = deleteAllMemberTrips(session);
  for (const share of listFamilyShares(ownerId, normalized)) {
    if (share.category === "trip") markFamilyShareRemoved(ownerId, normalized, "trip", share.joyceItemId);
  }
  deleteFamilyTrips(ownerId, normalized);
  return removed;
}

/** The country is switched off: it comes off every shared trip, and no per-trip choice keeps it. */
export function clearSharedTripCountries(ownerId: number, phone: string, session: FamilySession | null): void {
  const normalized = normalizePhone(phone);
  if (session) clearMemberTripCountries(session);
  for (const row of listFamilyTrips(ownerId, normalized)) {
    if (row.shareCountry) saveFamilyTrip(ownerId, normalized, { ...row, shareCountry: false });
  }
}

/** The country is switched on in automatic mode: shared trips that have one now carry it. */
export function addCountriesToSharedTrips(ownerId: number, phone: string, session: FamilySession): void {
  const normalized = normalizePhone(phone);
  for (const row of listFamilyTrips(ownerId, normalized)) {
    if (row.state !== "shared" || row.country === null || row.joyceTripId === null) continue;
    shareTrip(ownerId, normalized, session, row, true);
  }
}

/**
 * What Joyce is told about someone's dates. Anything short of a clear answer is not_sure: no
 * Marlo, availability off, no calendar, a calendar that failed, or a phone that isn't the one
 * that consented. The days Marlo knows about a trip count as clashes whether or not it was shared.
 */
export async function resolveAvailability(
  phone: string,
  from: string,
  to: string,
  zone: string
): Promise<AvailabilityAnswer> {
  try {
    const normalized = normalizePhone(phone);
    const ownerId = resolveOwnerByPhone(normalized);
    if (ownerId === null) return { status: "not_sure" };
    const link = getFamilyLink(ownerId, normalized);
    if (!link || !link.availabilityOn) return { status: "not_sure" };
    const { start, end } = rangeInstants(from, to, zone);
    const { events, complete } = await hubListEventsBetween(ownerId, start, end);
    if (!complete) return { status: "not_sure" };
    return computeAvailability(events, tripsForOwner(ownerId, from), from, to, zone);
  } catch (err) {
    console.error("bridge: couldn't work out availability", err);
    return { status: "not_sure" };
  }
}
