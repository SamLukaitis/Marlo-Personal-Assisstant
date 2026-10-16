import {
  clearOnboardingState,
  countFamilyMembers,
  createFamily,
  getOnboardingState,
  joinFamilyByCode,
  normalizeJoinCode,
  setOnboardingState,
} from "./registry.js";
import { openFamilySessionForNewMember, type FamilySession } from "./familyDb.js";
import { setMemberName } from "./store.js";

// Getting someone from "a number that has never messaged Joyce" to "a named member of a family".
// Three questions at most: who I am, new family or existing one, and what to call you.
//
// The state for the first two lives in the registry (there is no family yet to store it in); the
// third needs no state at all, because "this member has no name yet" is already representable as
// members.display_name_enc IS NULL in the family's own database.

export const INTRO =
  "Hi, I'm Joyce 👋 I'm a family assistant.\n\n" +
  "I help a family plan things together, keep hold of important information, and remind each " +
  "other about what's coming up. Everything one of you tells me, the rest of you can ask me " +
  "about.\n\n" +
  "Would you like to *start a new family group*, or *join an existing one*?";

const ASK_CODE =
  "No problem — send me the family ID you were given. It looks like *JOY-XXXX-XXXX*.";

const ASK_CHOICE_AGAIN =
  "Sorry, I didn't catch that. Reply *new* to start a family group, or *join* if someone has " +
  "already sent you a family ID.";

function askName(memberCount: number): string {
  return memberCount <= 1
    ? "Last thing — what should I call you?"
    : "Welcome in! What should I call you, so everyone knows who's who?";
}

function welcomeNewFamily(joinCode: string): string {
  return (
    "Done — your family group is set up 🎉\n\n" +
    `Your family ID is *${joinCode}*\n\n` +
    "Share that with the people you want in the group; they message me and send that ID to " +
    "join. Anyone with it can join, so pass it on privately — you can ask me for a new ID any " +
    "time and the old one stops working."
  );
}

/**
 * Matched strictly, not fuzzily. Anything that isn't clearly one of these gets the question
 * again — Joyce guessing that "dunno, the second one I think" meant *join* is how someone ends
 * up in the wrong place, and the cost of re-asking is one message.
 */
const NEW_WORDS = new Set(["new", "1", "one", "start", "create", "new family", "start new"]);
const JOIN_WORDS = new Set(["join", "2", "two", "existing", "join existing", "join one"]);

export type OnboardingResult =
  /** Still onboarding — send `reply` and stop; no assistant turn this message. */
  | { done: false; reply: string }
  /** They're in a family now. `session` is open and `reply` (if set) goes out first. */
  | { done: true; session: FamilySession; reply?: string };

/**
 * Drives everything that happens before someone is a named member of a family. Called only for
 * numbers with no family (joyce/routes.ts checks first), so it can't disturb an existing member.
 */
export function handleOnboarding(normalizedPhone: string, text: string): OnboardingResult {
  const step = getOnboardingState(normalizedPhone);
  const trimmed = text.trim();
  const lowered = trimmed.toLowerCase();

  // First contact: introduce, explain, ask.
  if (step === null) {
    setOnboardingState(normalizedPhone, "awaiting_choice");
    return { done: false, reply: INTRO };
  }

  if (step === "awaiting_join_code") {
    return applyJoinCode(normalizedPhone, trimmed);
  }

  // awaiting_choice.
  if (NEW_WORDS.has(lowered)) {
    const { family, joinCode } = createFamily(normalizedPhone);
    const session = openFamilySessionForNewMember(family, normalizedPhone);
    return { done: true, session, reply: `${welcomeNewFamily(joinCode)}\n\n${askName(1)}` };
  }

  if (JOIN_WORDS.has(lowered)) {
    setOnboardingState(normalizedPhone, "awaiting_join_code");
    return { done: false, reply: ASK_CODE };
  }

  // Someone who was forwarded a code often just pastes it instead of answering the question.
  // normalizeJoinCode is strict about length and alphabet, so this recognises an actual code
  // rather than guessing at intent.
  if (normalizeJoinCode(trimmed)) return applyJoinCode(normalizedPhone, trimmed);

  return { done: false, reply: ASK_CHOICE_AGAIN };
}

function applyJoinCode(normalizedPhone: string, rawCode: string): OnboardingResult {
  const outcome = joinFamilyByCode(normalizedPhone, rawCode);
  if (!outcome.ok) {
    if (outcome.reason === "already_in_a_family") {
      // Shouldn't be reachable (routes.ts only calls onboarding for family-less numbers), but if
      // it is, saying so plainly beats a confusing failure.
      clearOnboardingState(normalizedPhone);
      return { done: false, reply: "You're already part of a family group here." };
    }
    return {
      done: false,
      reply:
        "I don't recognise that family ID. Double-check it with whoever sent it — it looks " +
        "like *JOY-XXXX-XXXX* — and send it again.",
    };
  }

  const session = openFamilySessionForNewMember(outcome.family, normalizedPhone);
  return {
    done: true,
    session,
    reply: askName(countFamilyMembers(outcome.family.familyId)),
  };
}

/**
 * True when the family knows this member's phone but not their name — the one turn after
 * onboarding where Joyce should read the whole message as an answer rather than a request.
 */
export function needsName(session: FamilySession): boolean {
  return session.actor.displayName === null;
}

/**
 * Takes the message as the member's name. Capped and single-lined so a rambling reply can't turn
 * into an unusable name, but otherwise taken at face value — they can always tell Joyce to
 * change it later (the `set_my_name` tool), which is simpler and less annoying than trying to
 * work out whether "it's Sam!" is a name or a sentence.
 */
export function applyName(session: FamilySession, text: string): string {
  const name = text.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return "Sorry — what should I call you?";
  setMemberName(session, name);
  return (
    `Lovely to meet you, ${name}. Tell me anything the family should keep hold of, ask me to ` +
    `remind someone about something, or pass a message on — I'll take it from here.`
  );
}
