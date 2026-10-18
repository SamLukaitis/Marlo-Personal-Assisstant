import type { FamilySession } from "./familyDb.js";
import {
  clearFamilyCalendar,
  getFamilyCalendar,
  getGoogleAccountForMember,
  listGoogleAccounts,
  setFamilyCalendar,
  type FamilyCalendarSetting,
  type GoogleAccountRow,
} from "./store.js";
import {
  addCalendarToList,
  createGoogleCalendar,
  shareGoogleCalendar,
  unshareGoogleCalendar,
} from "./googleCalendar.js";

// The family calendar: one shared Google calendar, separate from everyone's own, where new events
// go unless someone asks for a particular person's calendar.
//
// Google has no calendar that belongs to a group, so it lives in the account of whoever asked
// Joyce to make it (the "owner"), and is shared with edit access to every other member who has
// connected Google. Each member sees it as its own layer in their Google Calendar app, and
// their personal calendar is never touched unless they ask.
//
// Only the owner's account can change who it's shared with, so:
//  - members connecting later are shared in through the owner's account;
//  - a member leaving is unshared through the owner's account;
//  - if the *owner* leaves, the family stops using it. It's still their calendar in Google,
//    and the family carrying on writing into it would mean someone outside the family seeing
//    everything they add. The family can ask Joyce for a new one.

export type CreateFamilyCalendarOutcome =
  | { ok: true; setting: FamilyCalendarSetting; sharedWith: string[]; notShared: string[] }
  | { ok: false; reason: "already_exists"; setting: FamilyCalendarSetting }
  | { ok: false; reason: "not_connected" };

/** Makes the family calendar in the speaker's account and shares it with every connected member. */
export async function createFamilyCalendar(
  session: FamilySession,
  name: string
): Promise<CreateFamilyCalendarOutcome> {
  const existing = getFamilyCalendar(session);
  if (existing) return { ok: false, reason: "already_exists", setting: existing };
  const owner = getGoogleAccountForMember(session, session.actor.id);
  if (!owner) return { ok: false, reason: "not_connected" };

  const calendarId = await createGoogleCalendar(session, owner, name);
  const setting: FamilyCalendarSetting = {
    calendarId,
    name,
    timeZone: owner.timeZone,
    ownerMemberId: owner.memberId,
  };
  // Saved before sharing, so a failure partway through still leaves the family with a calendar
  // rather than an orphan in someone's Google account and nothing pointing at it.
  setFamilyCalendar(session, setting);

  const sharedWith: string[] = [];
  const notShared: string[] = [];
  for (const member of listGoogleAccounts(session)) {
    if (member.memberId === owner.memberId) continue;
    const ok = await shareWithMember(session, owner, member, calendarId);
    (ok ? sharedWith : notShared).push(member.memberName ?? member.email);
  }
  return { ok: true, setting, sharedWith, notShared };
}

async function shareWithMember(
  session: FamilySession,
  owner: GoogleAccountRow,
  member: GoogleAccountRow,
  calendarId: string
): Promise<boolean> {
  try {
    await shareGoogleCalendar(session, owner, calendarId, member.email);
    await addCalendarToList(session, member, calendarId);
    return true;
  } catch (err) {
    console.error("joyce: couldn't share the family calendar with a member", err);
    return false;
  }
}

/**
 * Shares the family calendar with the person talking, who has just connected Google. Returns
 * whether there was a family calendar to share and whether it worked, for the connected page.
 */
export async function shareFamilyCalendarWithMe(
  session: FamilySession
): Promise<"no_family_calendar" | "owner" | "shared" | "failed"> {
  const setting = getFamilyCalendar(session);
  if (!setting) return "no_family_calendar";
  const me = getGoogleAccountForMember(session, session.actor.id);
  if (!me) return "failed";
  if (setting.ownerMemberId === me.memberId) {
    // The owner reconnecting: it's already theirs, just make sure it's in their list.
    await addCalendarToList(session, me, setting.calendarId).catch(() => undefined);
    return "owner";
  }
  const owner = getGoogleAccountForMember(session, setting.ownerMemberId);
  if (!owner) return "failed";
  return (await shareWithMember(session, owner, me, setting.calendarId)) ? "shared" : "failed";
}

/**
 * Called when the person talking is about to leave the family, before their Google account is
 * removed. Synchronous: the unsharing runs in the background and only logs if it fails.
 */
export function onMemberLeaving(session: FamilySession): void {
  const setting = getFamilyCalendar(session);
  if (!setting) return;
  if (setting.ownerMemberId === session.actor.id) {
    clearFamilyCalendar(session);
    return;
  }
  const leaver = getGoogleAccountForMember(session, session.actor.id);
  const owner = getGoogleAccountForMember(session, setting.ownerMemberId);
  if (!leaver || !owner) return;
  unshareGoogleCalendar(session, owner, setting.calendarId, leaver.email).catch((err) =>
    console.error("joyce: couldn't unshare the family calendar from a leaving member", err)
  );
}

/**
 * Accounts that can reach the family calendar, best first: the speaker's own (so their Google
 * account is the one making the change), then the owner's, then anyone else's. Callers try them
 * in turn, since a member may have been shared in late or removed it from their list.
 */
export function familyCalendarAccounts(
  session: FamilySession,
  setting: FamilyCalendarSetting
): GoogleAccountRow[] {
  const rank = (a: GoogleAccountRow) => (a.isSelf ? 0 : a.memberId === setting.ownerMemberId ? 1 : 2);
  return listGoogleAccounts(session).sort((a, b) => rank(a) - rank(b));
}
