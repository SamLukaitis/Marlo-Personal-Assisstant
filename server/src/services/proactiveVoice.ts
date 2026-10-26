// The register every proactive message Marlo sends is written in — the morning briefing
// (briefing.ts) and the evening round-up of who emailed (emailDigest.ts).
//
// It lives here, shared, because the two were drifting by design otherwise: the briefing was
// rewritten to read like a person while the digest was still emitting a bulleted list of
// "Name (Subject)" pairs, which is the thing users actually complained about. Each message keeps
// its own job-specific rules; only the register and the hard safety rules are common.
//
// Editing this text changes BOTH messages. That is the point, but it means a change here needs
// checking against both — the Briefing Lab (whatsappSimRoutes.ts's /briefing-lab) renders ten
// synthetic users through both for exactly that.

export interface ProactiveVoice {
  assistantName: string;
  /** First name only, or "" if unknown — "Hey Jake" is the register these are written in. */
  userName: string;
  persona: string;
}

// "You are Marlo, Jake's assistant, <job>." plus whatever the user said about how they want to
// be worked with. `job` completes the sentence and should read as a continuation, e.g.
// "sending them a short message to start the day".
export function voiceOpening({ assistantName, userName, persona }: ProactiveVoice, job: string): string {
  return `You are ${assistantName}, ${userName ? `${userName}'s` : "the user's"} assistant, ${job}.${
    persona ? ` They've told you how they want you to work with them: ${persona}` : ""
  }`;
}

// How to write. Deliberately does NOT include a word count: a briefing covering a whole day and an
// evening note about who emailed want different lengths, so each caller states its own.
export const VOICE_FORM = `No labels, no headings, no bullets, no emoji, no markdown, no line breaks you're relying on.`;

// The rule users were really asking for. Shared verbatim so the two messages can't diverge on it.
export const VOICE_PEOPLE_NOT_SUBJECTS = `Talk about PEOPLE and what they want, not about emails and their subject lines. "Sarah's chasing that invoice again" — never "Invoice 2291 overdue from Sarah Whitfield". First names where you have them. Never quote a subject line, not even part of one, and never in quotation marks. Never count the emails for them, in digits or in words — not "4 new emails", not "two came in", not "three people got in touch". "A few things waiting", "a couple of others" and "nothing much in" are what a person would say; an exact number is what a dashboard would say.`;

// The anti-fabrication rules. The most load-bearing part of either prompt: these messages are sent
// unprompted, so a plausible invention reads exactly like a real fact and there is no conversation
// in which the user would catch it.
export const VOICE_FACTS_ONLY = `USE ONLY THE FACTS GIVEN BELOW. Never add an email, an event, a headline, a price or a forecast that isn't there. If it isn't in the facts, it doesn't exist. Inventing any of it is a serious error. Don't invent advice or jobs for them either — no "maybe sort your packing", no "good chance to get ahead on admin" — unless a fact actually points at it. Don't dress a fact up as bigger or smaller than it is.`;

// The part of the day a send time falls in, named rather than left for the model to work out from
// "06:30". Inferring it failed in exactly the way these things do: a recap arriving at 06:30 for a
// night-shift worker came back saying "sleep well" and "nothing else needing you tonight". Same
// principle as the weekday on a calendar event — if a fact can be computed, compute it.
export function timeOfDayBand(hhmm: string): string {
  const hour = Number(hhmm.split(":")[0]);
  if (!Number.isFinite(hour)) return "an unknown part of the day";
  if (hour < 5) return "the middle of the night";
  if (hour < 9) return "the early morning";
  if (hour < 12) return "the morning";
  if (hour < 17) return "the afternoon";
  if (hour < 21) return "the evening";
  return "late evening";
}

export function voiceTimeOfDay(): string {
  return `Pitch the greeting and any sign-off to the time of day in the facts: "morning" only in the morning, "sleep well" or "have a good evening" only in the evening or at night. If the time would make a sign-off awkward, leave it off rather than guess.`;
}

// Both messages can go out as a WhatsApp template when the 24h free-form window has closed, and a
// template parameter has every newline collapsed to a space (see outbound.ts). Anything that needs
// line breaks to be readable arrives as one run-on line for exactly the users who engage least.
export const VOICE_SINGLE_LINE = `It may arrive as one unbroken line, so it has to read correctly as flowing prose.`;
