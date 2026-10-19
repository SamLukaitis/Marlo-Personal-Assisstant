// Two notifications Joyce sends to whoever registers for them, so the bridge to Marlowe
// (src/bridge/) can react to someone joining or leaving a family without Joyce importing anything
// outside this directory (see the boundary test in onboarding.test.ts). With nothing registered —
// Joyce on her own, or any test — they do nothing.
//
// A hook that throws must never break onboarding or leaving: those are the moments a person is
// in the middle of something, and the hook only ever adds an optional extra.

export interface FamilyHooks {
  onFamilyJoined?: (normalizedPhone: string) => void;
  onFamilyLeft?: (normalizedPhone: string) => void;
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

export function fireFamilyLeft(normalizedPhone: string): void {
  try {
    hooks.onFamilyLeft?.(normalizedPhone);
  } catch (err) {
    console.error("joyce: onFamilyLeft hook failed", err);
  }
}
