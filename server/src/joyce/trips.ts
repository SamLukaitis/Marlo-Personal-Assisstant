// The trips a member's Marlowe has shared with the family: dates, and the country only if the
// person allowed it. Nothing else is stored here, no booking data and no Marlowe ids; the bridge
// (src/bridge/) is what writes and removes these rows.
import { decryptFor, encryptFor } from "./familyKey.js";
import type { FamilySession } from "./familyDb.js";

export interface MemberTrip {
  id: number;
  memberId: number;
  memberName: string | null;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD, inclusive
  country: string | null;
}

/** Writes a trip as the session's member. Returns the row id. */
export function saveMemberTrip(
  session: FamilySession,
  trip: { startDate: string; endDate: string; country: string | null }
): number {
  const res = session.db
    .prepare(`INSERT INTO member_trips (member_id, start_enc, end_enc, country_enc, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(
      session.actor.id,
      encryptFor(session.key, trip.startDate),
      encryptFor(session.key, trip.endDate),
      trip.country === null ? null : encryptFor(session.key, trip.country),
      Date.now()
    );
  return Number(res.lastInsertRowid);
}

/** Changes a trip this member's Marlowe shared. Refuses anyone else's row. */
export function updateMemberTrip(
  session: FamilySession,
  tripId: number,
  trip: { startDate: string; endDate: string; country: string | null }
): boolean {
  const res = session.db
    .prepare(`UPDATE member_trips SET start_enc = ?, end_enc = ?, country_enc = ? WHERE id = ? AND member_id = ?`)
    .run(
      encryptFor(session.key, trip.startDate),
      encryptFor(session.key, trip.endDate),
      trip.country === null ? null : encryptFor(session.key, trip.country),
      tripId,
      session.actor.id
    );
  return res.changes > 0;
}

/** Removes a trip this member's Marlowe shared. Refuses anyone else's row. */
export function deleteMemberTrip(session: FamilySession, tripId: number): boolean {
  return (
    session.db.prepare(`DELETE FROM member_trips WHERE id = ? AND member_id = ?`).run(tripId, session.actor.id)
      .changes > 0
  );
}

/** Takes the country off every trip this member shared, leaving the dates. */
export function clearMemberTripCountries(session: FamilySession): void {
  session.db.prepare(`UPDATE member_trips SET country_enc = NULL WHERE member_id = ?`).run(session.actor.id);
}

/** Removes every trip this member shared. */
export function deleteAllMemberTrips(session: FamilySession): number {
  return session.db.prepare(`DELETE FROM member_trips WHERE member_id = ?`).run(session.actor.id).changes;
}

/** Every member trip in the family that overlaps from..to (inclusive dates), soonest first. */
export function listTripsOverlapping(session: FamilySession, from: string, to: string): MemberTrip[] {
  const rows = session.db
    .prepare(
      `SELECT t.id, t.member_id, t.start_enc, t.end_enc, t.country_enc, m.display_name_enc
         FROM member_trips t JOIN members m ON m.id = t.member_id`
    )
    .all() as {
    id: number;
    member_id: number;
    start_enc: string;
    end_enc: string;
    country_enc: string | null;
    display_name_enc: string | null;
  }[];
  return rows
    .map((r) => ({
      id: r.id,
      memberId: r.member_id,
      memberName: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
      startDate: decryptFor(session.key, r.start_enc),
      endDate: decryptFor(session.key, r.end_enc),
      country: r.country_enc === null ? null : decryptFor(session.key, r.country_enc),
    }))
    .filter((t) => t.startDate <= to && t.endDate >= from)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** Every member with the name they gave and their number (null for anyone who joined before it was kept). */
export function listMemberPhones(session: FamilySession): { id: number; name: string | null; phone: string | null }[] {
  const rows = session.db
    .prepare(`SELECT id, display_name_enc, phone_enc FROM members ORDER BY joined_at ASC`)
    .all() as { id: number; display_name_enc: string | null; phone_enc: string | null }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.display_name_enc === null ? null : decryptFor(session.key, r.display_name_enc),
    phone: r.phone_enc === null ? null : decryptFor(session.key, r.phone_enc),
  }));
}
