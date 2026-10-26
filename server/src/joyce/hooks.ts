// Two notifications Joyce sends to whoever registers for them, so the bridge to Marlowe
// (src/bridge/) can react to someone joining or leaving a family without Joyce importing anything
// outside this directory (see the boundary test in onboarding.test.ts). With nothing registered —
// Joyce on her own, or any test — they do nothing.
//
// A hook that throws must never break onboarding or leaving: those are the moments a person is
// in the middle of something, and the hook only ever adds an optional extra.

/**
 * What a member's Marlowe will say about a run of dates, and nothing more. `free_except` carries
 * the days that clash (YYYY-MM-DD), never why. `not_sure` is also what Joyce gets when the person
 * has no Marlowe, has switched this off, or Marlowe couldn't tell, so those can't be told apart.
 */
export type AvailabilityAnswer =
  | { status: "free" }
  | { status: "busy" }
  | { status: "free_except"; busyDates: string[] }
  | { status: "not_sure" };

export interface FamilyHooks {
  onFamilyJoined?: (normalizedPhone: string) => void;
  onFamilyLeft?: (normalizedPhone: string) => void;
  /** Just before someone's number stops reaching the family, while their file can still be opened. */
  onFamilyLeaving?: (normalizedPhone: string) => void;
  /** Answers "is this member free from..to (YYYY-MM-DD, family time zone)?" See bridge/index.ts. */
  resolveAvailability?: (
    normalizedPhone: string,
    from: string,
    to: string,
    zone: string
  ) => Promise<AvailabilityAnswer>;
}

let hooks: FamilyHooks = {};

export function setFamilyHooks(next: FamilyHooks): void {
  hooks = next;
}

export function fireFamilyJoined(normalizedPhone: string): void {
  try {
    hooks.onFamilyJoined?.(normalizedPhone);
  } catch (err) {
    console.error("joyce: onFamilyJoined hook failed", err);
  }
}

export function fireFamilyLeaving(normalizedPhone: string): void {
  try {
    hooks.onFamilyLeaving?.(normalizedPhone);
  } catch (err) {
    console.error("joyce: onFamilyLeaving hook failed", err);
  }
}

export function fireFamilyLeft(normalizedPhone: string): void {
  try {
    hooks.onFamilyLeft?.(normalizedPhone);
  } catch (err) {
    console.error("joyce: onFamilyLeft hook failed", err);
  }
}

// How long Joyce waits for one person's Marlowe before saying she isn't sure about them.
const AVAILABILITY_TIMEOUT_MS = 10_000;

/** Asks the registered resolver. Anything but a clear answer, including no resolver, is not_sure. */
export async function askAvailability(
  normalizedPhone: string,
  from: string,
  to: string,
  zone: string
): Promise<AvailabilityAnswer> {
  const resolve = hooks.resolveAvailability;
  if (!resolve) return { status: "not_sure" };
  try {
    return await Promise.race([
      resolve(normalizedPhone, from, to, zone),
      new Promise<AvailabilityAnswer>((r) => setTimeout(() => r({ status: "not_sure" }), AVAILABILITY_TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    console.error("joyce: resolveAvailability hook failed", err);
    return { status: "not_sure" };
  }
}
