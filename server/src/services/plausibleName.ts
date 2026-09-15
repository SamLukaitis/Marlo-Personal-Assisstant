// Crude but effective filter against a free-text reply being mistaken for a person's name.
// Root cause of a real bug: the onboarding chain asks "what should I call you?" twice — once in
// whatsappRegistration.ts's pre-connect flow, again in postConnectSetup.ts's post-connect flow
// (see startPostConnectSetup) — so a user who already answered once and gets asked again can
// reasonably reply with something like "I already said Sam" instead of just "Sam". Both call
// sites saved that whole reply verbatim as the permanent display name, which then leaked into
// every personalized proactive message (e.g. importantEmailAlerts.ts's "{name}, ...:" greeting),
// producing messages like "I already said Sam, an email about ... just came in".
//
// A real name is a handful of short words with no sentence punctuation — this rejects anything
// longer or more sentence-shaped without trying to be a real NLP name detector.
export function isPlausibleName(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 3) return false;
  return /^[\p{L}\p{M}'.\- ]+$/u.test(trimmed);
}
