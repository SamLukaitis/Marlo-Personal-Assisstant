import fs from "node:fs";
import {
  clearReplayPark,
  deletePendingRegistration,
  deleteUserCompletely,
  findRemainingOwnerReferences,
  normalizePhone,
  resolveOwnerByPhone,
} from "../db/store.js";

// Thrown when the account purge fails — carries whichever owner_id-referencing tables still hold
// rows, so the caller can name exactly what blocked it instead of a generic failure.
export class TestPhoneResetError extends Error {
  constructor(
    message: string,
    public readonly offenders: ReturnType<typeof findRemainingOwnerReferences>
  ) {
    super(message);
    this.name = "TestPhoneResetError";
  }
}

// Returns a phone number to a clean pre-signup state: wipes any in-progress registration and, if
// it's already bound to a full account, that account entirely (every table, plus the uploaded
// files themselves) so the same number can go through signup again. Irreversible. Shared by the
// admin reset-test-phone route and the WhatsApp Simulator's "delete test user".
export function resetTestPhone(rawPhone: string): { hadAccount: boolean; clearedReplayPark: boolean } {
  const phone = normalizePhone(rawPhone);
  deletePendingRegistration(phone);

  const ownerId = resolveOwnerByPhone(phone);
  // Replay-onboarding leaves the number unbound but remembers which account it came from, so the
  // next registration is handed back to that account rather than creating a second one (see
  // resetOnboardingConnectionState). A reset's whole promise is that the same number can go
  // through signup from a clean slate, which that marker would quietly break — so drop it.
  //
  // Deliberately does NOT wipe the account the marker points at: that is a live account mid-replay
  // whose data replay exists to preserve, and following the marker here would make this a one-tap
  // wipe of the operator's own hub. An earlier version refused the whole request with a 409
  // instead, which removed the only escape hatch from a number nothing else could unstick.
  const clearedReplayPark = clearReplayPark(phone);
  if (ownerId !== null) {
    try {
      const { deletedDocumentPaths } = deleteUserCompletely(ownerId);
      for (const p of deletedDocumentPaths) {
        try {
          fs.unlinkSync(p);
        } catch {
          // best-effort — a missing file on disk shouldn't block the rest of the reset
        }
      }
    } catch (err) {
      // The transaction rolled back on throw, so ownerId's rows are all still intact here —
      // naming exactly which table blocked it beats another guess-and-redeploy cycle (this purge
      // list has gone stale three times already).
      throw new TestPhoneResetError((err as Error).message, findRemainingOwnerReferences(ownerId));
    }
  }
  return { hadAccount: ownerId !== null, clearedReplayPark };
}
