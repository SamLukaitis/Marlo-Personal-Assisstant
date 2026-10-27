// The bridge between a person's Marlo and their family's Joyce. This is the only code that
// imports both products: src/joyce/ imports nothing outside itself (onboarding.test.ts enforces
// it), and Marlo's assistant reaches Joyce only through the functions below.
//
// Every function resolves the family from the caller's own phone number, the same way Joyce does
// for an inbound message. None takes a family id or a member id, so there is nothing a model could
// point at someone else's family. What crosses is a short fixed list: handing a note over now,
// the dates a person is away (and the country, only if they chose), and free/busy answers.
//
// Consent and settings live in Marlo's app.db (family_links); the audit log of what has been
// shared is family_link_shares. Joyce only keeps a "linked" flag on the member and a source marker
// on the notes handed over, so an unlink can take them back.
import {
  deleteFamilyLink,
  getFamilyLink,
  hasInboundWhatsAppMessage,
  listFamilyShares,
  logFamilyShare,
  markFamilySharesRemoved,
  normalizePhone,
  resolveOwnerByPhone,
  upsertFamilyLink,
  type FamilyLinkRow,
  type FamilyShareRow,
} from "../db/store.js";
import { sendProactiveMessage } from "../services/outbound.js";
import { findFamilyForPhone } from "../joyce/registry.js";
import { openFamilySessionForPhone } from "../joyce/familyDb.js";
import { deleteMarloweNote, saveNote, setMarloweLinked } from "../joyce/store.js";
import { setFamilyHooks } from "../joyce/hooks.js";
import {
  addCountriesToSharedTrips,
  clearSharedTripCountries,
  removeSharedTrips,
  resolveAvailability,
  syncTripsForPhone,
} from "./trips.js";

export {
  answerTripQuestion,
  openTripQuestions,
  resolveAvailability,
  syncTripsForOwner,
  syncTripsForPhone,
  type AnswerResult,
  type TripChoice,
} from "./trips.js";

type Settings = {
  tripsMode?: FamilyLinkRow["tripsMode"];
  tripsCountry?: boolean;
  availabilityOn?: boolean;
};

export interface FamilyLinkState {
  inFamily: boolean;
  linked: boolean;
  tripsMode?: FamilyLinkRow["tripsMode"];
  tripsCountry?: boolean;
  availabilityOn?: boolean;
}

// Whether this phone belongs to a Joyce family. For code outside the bridge that only needs to know,
// such as the change-phone script, so it never imports Joyce directly.
export function isInJoyceFamily(phone: string): boolean {
  return findFamilyForPhone(normalizePhone(phone)) !== null;
}

export function familyLinkState(ownerId: number, phone: string): FamilyLinkState {
  const inFamily = findFamilyForPhone(normalizePhone(phone)) !== null;
  const link = getFamilyLink(ownerId, phone);
  return {
    inFamily,
    // A link outlives nothing: someone who is no longer in a family is not linked to it.
    linked: inFamily && link !== null,
    ...(inFamily && link
      ? { tripsMode: link.tripsMode, tripsCountry: link.tripsCountry, availabilityOn: link.availabilityOn }
      : {}),
  };
}

export function linkToFamily(
  ownerId: number,
  phone: string,
  settings: Settings = {}
): { ok: true; link: FamilyLinkRow } | { ok: false; reason: "not_in_family" } {
  const normalized = normalizePhone(phone);
  const session = openFamilySessionForPhone(normalized);
  if (!session) return { ok: false, reason: "not_in_family" };
  setMarloweLinked(session, true);
  const link = upsertFamilyLink(ownerId, normalized, settings);
  startTripSync(ownerId, normalized);
  return { ok: true, link };
}

function startTripSync(ownerId: number, phone: string): void {
  syncTripsForPhone(ownerId, phone).catch((err) => console.error("bridge: couldn't sync trips", err));
}

export function updateLinkSettings(
  ownerId: number,
  phone: string,
  settings: Settings
): { ok: true; link: FamilyLinkRow } | { ok: false; reason: "not_in_family" | "not_linked" } {
  const state = familyLinkState(ownerId, phone);
  if (!state.inFamily) return { ok: false, reason: "not_in_family" };
  if (!state.linked) return { ok: false, reason: "not_linked" };
  const normalized = normalizePhone(phone);
  const before = getFamilyLink(ownerId, normalized) as FamilyLinkRow;
  const link = upsertFamilyLink(ownerId, normalized, settings);
  const session = openFamilySessionForPhone(normalized);
  // Switching a category off takes back what it had shared, at once. Availability shares nothing
  // that stays, so it only needs to stop answering; handed-over notes are never a setting.
  if (link.tripsMode === "off" && before.tripsMode !== "off") {
    removeSharedTrips(ownerId, normalized, session);
  }
  if (before.tripsCountry && !link.tripsCountry) clearSharedTripCountries(ownerId, normalized, session);
  if (!before.tripsCountry && link.tripsCountry && link.tripsMode === "auto" && session) {
    addCountriesToSharedTrips(ownerId, normalized, session);
  }
  if (link.tripsMode !== "off" && before.tripsMode !== link.tripsMode) startTripSync(ownerId, normalized);
  return { ok: true, link };
}

/**
 * Ends the link. With `removeShared`, also deletes the notes this person's Marlo handed over
 * (found through the audit log, so only theirs, and only notes still carrying the marlowe marker).
 */
export function unlinkFromFamily(ownerId: number, phone: string, removeShared: boolean): { removed: number } {
  const normalized = normalizePhone(phone);
  const session = openFamilySessionForPhone(normalized);
  let removed = 0;
  // Trips always come down: they say where a person is, and shouldn't outlive their link.
  removeSharedTrips(ownerId, normalized, session);
  if (removeShared && session) {
    for (const share of listFamilyShares(ownerId, normalized)) {
      if (share.category === "note" && deleteMarloweNote(session, share.joyceItemId)) removed += 1;
    }
    markFamilySharesRemoved(ownerId, normalized);
  }
  if (session) setMarloweLinked(session, false);
  deleteFamilyLink(ownerId, normalized);
  return { removed };
}

export function sendToFamily(
  ownerId: number,
  phone: string,
  title: string,
  body: string
): { ok: true; noteId: number } | { ok: false; reason: "not_in_family" | "not_linked" | "empty" } {
  const state = familyLinkState(ownerId, phone);
  if (!state.inFamily) return { ok: false, reason: "not_in_family" };
  if (!state.linked) return { ok: false, reason: "not_linked" };
  const cleanTitle = title.trim();
  const cleanBody = body.trim();
  if (!cleanTitle || !cleanBody) return { ok: false, reason: "empty" };
  const session = openFamilySessionForPhone(normalizePhone(phone))!;
  const noteId = saveNote(session, cleanTitle, cleanBody, "marlowe");
  // The log keeps the title only, never the body.
  logFamilyShare(ownerId, phone, "note", cleanTitle.slice(0, 80), noteId);
  return { ok: true, noteId };
}

export function listShared(ownerId: number, phone: string): FamilyShareRow[] {
  return listFamilyShares(ownerId, phone);
}

const OFFER_TEXT =
  "I see you've joined a family group on Joyce, our family assistant. Want me to connect your Marlo to it? " +
  "Nothing is shared unless you say yes.\n\n" +
  "If you do, I can:\n" +
  "• let your family see the dates you're away, and the country only if you choose (I'd ask you about each trip)\n" +
  "• let Joyce check whether you're free for dates your family proposes. She only hears which days clash, never why\n" +
  '• pass things on when you say "send this to Joyce"\n\n' +
  "Your emails and our chats stay private. Reply yes to connect, or tell me how you'd like it set up.";

/**
 * Offers the link to someone who has just joined a family on Joyce. Only to a number with a
 * Marlo account that has messaged Marlo itself: a number added to an account from the web
 * Settings page proves nothing about who holds it.
 */
export async function offerLink(phone: string): Promise<void> {
  const normalized = normalizePhone(phone);
  const ownerId = resolveOwnerByPhone(normalized);
  if (ownerId === null) return;
  if (!hasInboundWhatsAppMessage(ownerId, normalized)) return;
  if (getFamilyLink(ownerId, normalized)) return;
  await sendProactiveMessage(normalized, OFFER_TEXT, "alert");
}

// Just before someone's number stops reaching the family: their trips come down while their file
// can still be opened, since leaving would otherwise strand them there.
function handleLeaving(phone: string): void {
  const normalized = normalizePhone(phone);
  const ownerId = resolveOwnerByPhone(normalized);
  if (ownerId === null) return;
  removeSharedTrips(ownerId, normalized, openFamilySessionForPhone(normalized));
}

// Someone who leaves their family is unlinked at once. The notes they handed over stay with the
// family, as everything else a member contributed does.
function handleLeft(phone: string): void {
  const normalized = normalizePhone(phone);
  const ownerId = resolveOwnerByPhone(normalized);
  if (ownerId === null) return;
  deleteFamilyLink(ownerId, normalized);
}

/** Connects Joyce's join/leave notifications to the bridge. Called once at server start. */
export function registerBridge(): void {
  setFamilyHooks({
    onFamilyJoined: (phone) => {
      offerLink(phone).catch((err) => console.error("bridge: couldn't offer the Joyce link", err));
    },
    onFamilyLeaving: handleLeaving,
    onFamilyLeft: handleLeft,
    resolveAvailability,
  });
}
