// Shared by briefing.ts, scheduler.ts, and postConnectSetup.ts — was duplicated in the first two
// until postConnectSetup.ts needed the same "what calendar day is it, server-local" key to stamp
// last_proactive_send_date during onboarding. One copy so the three can't drift.
export function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")}`;
}
