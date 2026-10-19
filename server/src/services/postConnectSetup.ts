// The setup chain run right after OAuth connects a mailbox: the user's name, then a first-task
// check, then daily briefing (yes/no, content defaulted), then Teams chat search (skipped for
// non-Microsoft owners). See docs/superpowers/specs/2026-08-28-whatsapp-onboarding-redesign-design.md
// for the original design and docs/superpowers/specs/2026-09-15-onboarding-seamless-design.md for
// the trim/wow-moment follow-up — this replaces the earlier version of this file, which asked
// about Schengen tracking unconditionally and stacked the briefing-content question directly
// behind the Teams question with no wait (see whatsappRegistration.ts's
// sendFirstValueAndBriefingPrompt, which kicks this off, still unchanged).
//
// Reuses the exact same save functions the assistant's own set_briefing_preferences/
// set_tool_enabled tools call — this is a different trigger for the same preferences, not a new
// preference-writing path.
//
// A registered number is routed straight to the real assistant (handleIncoming in
// whatsappRoutes.ts), not a registration-style state machine, so a button tap answering one of
// the yes/no questions here needs its own small piece of state (pending_setup in db/store.ts) to
// be recognized instead of falling through as an unrecognized interactive message. The one
// free-text step (ask_first_task) works differently: it waits for a real text reply (a "skip" or
// an actual request), forwards a genuine request through ordinary chat handling (handleText, from
// chatDispatch.ts) so it gets a real answer, and only then advances the chain — never stacking the
// next scripted question behind an unanswered one.
import {
  getPendingSetup,
  setPendingSetup,
  clearPendingSetup,
  claimPendingSetup,
  setToolEnabled,
  setSetting,
  getSetting,
  listAccounts,
} from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings, hasBriefingSettings } from "./briefing.js";
import { userLocalClock } from "./userTimezone.js";
import { sendScriptedText, sendScriptedButtons } from "./whatsappReply.js";
import { hubListEvents } from "./hub.js";
import { handleText } from "./chatDispatch.js";
import { isPlausibleName } from "./plausibleName.js";
import { wantsToContinueSetup } from "./setupIntent.js";
import { markOnboardingConnected } from "./onboardingAlertSuppression.js";
import { scanAndCurateImportantEmailsForOnboarding } from "./importantEmailAlerts.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";
import type { NewsTopic } from "../providers/news.js";
import { usesBusinessOnboarding, saveBusinessDescription } from "../editions/index.js";

const BUTTON_IDS: Record<"ask_briefing" | "ask_teams", { yes: string; no: string }> = {
  ask_briefing: { yes: "briefing_yes", no: "briefing_no" },
  ask_teams: { yes: "teams_yes", no: "teams_no" },
};

// Matches a reply that means "nothing else, move on" for the ask_name step (ask_first_task uses
// setupIntent.ts's wider check instead) — deliberately
// permissive (whole-message match, case-insensitive) rather than a substring search, so an actual
// request that happens to contain one of these words ("skip the intro and just tell me...") isn't
// misread as a skip.
const SKIP_PATTERN = /^(skip|no|no thanks|nothing|none|all good|i'?m good|let'?s continue|continue|finish setup)$/i;
function isSkip(text: string): boolean {
  return SKIP_PATTERN.test(text.trim());
}

async function reply(phone: string, text: string): Promise<void> {
  await sendScriptedText(phone, text);
}

async function askName(ownerId: number, phone: string): Promise<void> {
  await reply(phone, "Before we get started — what should I call you?");
  setPendingSetup(ownerId, "ask_name");
}

async function askFirstTask(ownerId: number, phone: string): Promise<void> {
  await reply(
    phone,
    "Anything you'd like me to look at right now, or shall we finish setting up? Just ask, or say *skip*."
  );
  setPendingSetup(ownerId, "ask_first_task");
}

// Business edition (docs/superpowers/specs/2026-10-16-business-edition-design.md §4): after the
// name, ask what the business does (it sharpens receipt categorising), then invite a first receipt
// so the core feature is seen inside setup, not discovered later.
async function askBusiness(ownerId: number, phone: string): Promise<void> {
  await reply(
    phone,
    "What does your business do? Something short like *plumber in Leeds* or *wedding photographer* is perfect — it helps me file your receipts right. Or say *skip*."
  );
  setPendingSetup(ownerId, "ask_business");
}

async function askFirstReceipt(ownerId: number, phone: string): Promise<void> {
  await reply(
    phone,
    "Let's try it: send me a photo of any receipt or invoice and I'll add it to your books. Or say *skip* and we'll finish setting up."
  );
  setPendingSetup(ownerId, "ask_first_receipt");
}

// What follows the name question: the business steps for business users, the open first-task
// question for everyone else.
async function askAfterName(ownerId: number, phone: string): Promise<void> {
  if (usesBusinessOnboarding(ownerId)) await askBusiness(ownerId, phone);
  else await askFirstTask(ownerId, phone);
}

async function askBriefing(ownerId: number, phone: string): Promise<void> {
  if (usesBusinessOnboarding(ownerId)) {
    await sendScriptedButtons(
      phone,
      "Want a short morning message with your email, calendar and any receipts that need a quick check — plus last week's money in and out on Mondays?",
      [
        { id: BUTTON_IDS.ask_briefing.yes, title: "Yes please" },
        { id: BUTTON_IDS.ask_briefing.no, title: "No thanks" },
      ]
    );
    setPendingSetup(ownerId, "ask_briefing");
    return;
  }
  await sendScriptedButtons(
    phone,
    "Want a daily morning update with your email, calendar, and anything that looks like it needs a reply?",
    [
      { id: BUTTON_IDS.ask_briefing.yes, title: "Yes please" },
      { id: BUTTON_IDS.ask_briefing.no, title: "No thanks" },
    ]
  );
  setPendingSetup(ownerId, "ask_briefing");
}

// The old ask_briefing_content step asked separately what to include (news/business/weather) —
// dropped as its own round trip (see docs/superpowers/specs/2026-09-15-onboarding-seamless-design.md).
// Content now defaults to top-story news on a Yes, since that's the only one of the three that
// needs no further setup — weather needs a saved location and markets need tickers, neither of
// which onboarding collects, so turning those on by default would do nothing. Still adjustable
// any time via the assistant's own set_briefing_preferences tool.
const DEFAULT_BRIEFING_TOPICS: NewsTopic[] = ["world", "business"];

async function announceBriefingDefault(phone: string): Promise<void> {
  await reply(
    phone,
    "Great — I'll send that each morning, with today's top headlines included. Just tell me anytime " +
      "if you'd like to add weather or markets too, or drop the news."
  );
}

async function askTeams(ownerId: number, phone: string): Promise<void> {
  await sendScriptedButtons(phone, "Want me to also search *Microsoft Teams* chats when you ask?", [
    { id: BUTTON_IDS.ask_teams.yes, title: "Yes" },
    { id: BUTTON_IDS.ask_teams.no, title: "No thanks" },
  ]);
  setPendingSetup(ownerId, "ask_teams");
}

// Note: this never mentions mail found while setting up — people's emails go to the evening
// digest and everything else through the attention gate (attention.ts), each concretely.
async function sendClosingMessage(phone: string): Promise<void> {
  await reply(
    phone,
    '*All set!* ✅ Ask me anything, or say *help* any time.\n\n' +
      "One more thing — I'm still in testing, and my developers *Sam* and *Jake* want your feedback. " +
      "If something's off or you have a request for a new feature, just tell me and I'll send it over " +
      "to them to build ASAP. Any request I can't meet already gets flagged to them automatically :)"
  );
  // Its own message rather than a third paragraph above: the chain otherwise ends on a statement,
  // and someone who has just finished tapping through setup is left with no obvious next move. An
  // open "any questions?" here still left new testers guessing what to ask, so it's a few concrete
  // things to try instead — the handoff into ordinary chat. pending_setup is already cleared by
  // both callers of this function, so whatever they reply goes straight to the assistant.
  await reply(
    phone,
    "A few things to try:\n\n" +
      "• \"What's on my calendar this week?\"\n" +
      "• \"Find me flights from London to Barcelona 20–23 Nov\"\n" +
      "• Send me a photo of a receipt or booking and I'll save the details\n" +
      "• \"Remind me at 6pm to call Mum\""
  );
}

// Only Microsoft-connected owners can have anything in Teams — asking everyone made the chain
// longer for the majority (Google) of test users for a question that could never apply to them.
async function askTeamsOrFinish(ownerId: number, phone: string): Promise<void> {
  const hasMicrosoft = listAccounts(ownerId, "microsoft").length > 0;
  if (hasMicrosoft) {
    await askTeams(ownerId, phone);
  } else {
    clearPendingSetup(ownerId);
    await sendClosingMessage(phone);
  }
}

// Called from the OAuth callback (via whatsappRegistration.ts) once the mailbox is actually
// connected. Sends the "connected" confirmation + a best-effort first-value fact, then starts the
// chain with the first-task check.
//
// linkedExistingAccount (Task 8): true when the owner's account predates this connection — a
// phone-only user who used Marlowe for a while before connecting a mailbox via the assistant's
// own connect_email tool, rather than someone signing up fresh. askName/askFirstTask are always
// skipped for this case: the user is mid-conversation, already named (guarded below the same way
// as a fresh signup), and "anything you'd like me to look at right now, or shall we finish setting
// up?" reads as reverting to onboarding mode for someone who's been chatting with Marlowe for
// weeks. askBriefing is narrower: it's skipped only when hasBriefingSettings(ownerId) is already
// true, because its Yes/No handler (handlePostConnectSetupReply) unconditionally overwrites
// `topics` via saveBriefingSettings — a real data-loss risk if the person configured it through
// the assistant's own set_briefing_preferences tool before ever connecting a mailbox — but for the
// majority who never touched it, running the question is still the right call: it's the
// highest-value item in the chain (a two-button tap converts far better than being told to ask for
// it later), and skipping it unconditionally would also drop askTeamsOrFinish's Microsoft-Teams
// question and the closing message's feedback prompt, the only in-product feedback channel for
// WhatsApp-only users, for every linked-later user including the ones with nothing to protect.
export async function startPostConnectSetup(
  ownerId: number,
  phone: string,
  linkedExistingAccount = false
): Promise<void> {
  // Anchors onboardingAlertSuppression.ts's grace period to this exact moment — see its own
  // comment for why this matters independently of how fast the chain below is answered.
  markOnboardingConnected(ownerId);
  let fact = "";
  try {
    const [events, importantPreview] = await Promise.all([
      hubListEvents(ownerId, 1).catch(() => []),
      // Bounded to mail from the 24 hours before connecting (see importantEmailAlerts.ts's
      // isWithinOnboardingLookback) — a user's own feedback: surfacing a whole backlog of older
      // "important-looking" automated mail (subscription renewals, delivery notices, ...) the
      // moment someone signs up read as Marlowe spamming them with old mail, not as a useful
      // finding. Anything older is still baselined (never re-alerted on later) — it's just never
      // shown here.
      scanAndCurateImportantEmailsForOnboarding(ownerId).catch((err) => {
        console.error(`postConnectSetup: onboarding important-email scan failed for owner ${ownerId}`, err);
        return null;
      }),
    ]);

    const calendarSentence = (() => {
      const nextEvent = events[0];
      if (nextEvent?.title) {
        return events.length > 1
          ? `*${nextEvent.title}* on today's calendar (plus ${events.length - 1} more)`
          : `*${nextEvent.title}* on today's calendar`;
      }
      if (events.length > 0) return `*${events.length} thing${events.length === 1 ? "" : "s"}* on today's calendar`;
      return null;
    })();

    if (importantPreview && importantPreview.lines.length > 0) {
      // A real, curated finding from the last 24 hours is listed right in the Connected message
      // — a user's own feedback: "instead of something like 20 unread emails it should say the
      // most important emails". Its own paragraph (it's multi-line), with the calendar fact
      // folded in as a trailing sentence rather than forced into the single joined sentence below.
      const more =
        importantPreview.moreCount > 0
          ? `\n...plus ${importantPreview.moreCount} more — just ask and I'll run through them.`
          : "";
      const calendarNote = calendarSentence ? ` I can also see ${calendarSentence}.` : "";
      fact = `\n\nI can already see a few important things from the last 24 hours:\n${importantPreview.lines.join("\n")}${more}${calendarNote}`;
    } else if (importantPreview) {
      // Scanned and found nothing important. Deliberately no unread count: it only ever covered
      // the 20 most recent emails (so a busy inbox always read "20"), and "I checked, nothing
      // needs you" shows judgement where a count just repeats the phone's own badge.
      const calendarNote = calendarSentence ? ` You've also got ${calendarSentence}.` : "";
      fact =
        " Nothing urgent in your inbox from the last 24 hours — I'll message you the moment something important comes in." +
        calendarNote;
    } else {
      // null: the scan couldn't actually check, so make no claim about the inbox at all.
      fact = calendarSentence ? ` I can already see ${calendarSentence}.` : "";
    }
  } catch {
    // best-effort — a missing first-value fact shouldn't block the confirmation message itself
  }

  await reply(phone, `*Connected!* ✅ I can see your inbox and your calendar.${fact}`);
  if (linkedExistingAccount) {
    if (hasBriefingSettings(ownerId)) {
      // Already answered (or deliberately left at defaults) via set_briefing_preferences — asking
      // again would risk the topics-overwrite described above for no benefit, so go straight to
      // the next question that's still genuinely new (Teams, for a Microsoft-linked owner) or the
      // closing/feedback message.
      await askTeamsOrFinish(ownerId, phone);
    } else {
      await askBriefing(ownerId, phone);
    }
    return;
  }
  // Pre-connect registration (whatsappRegistration.ts's sendFirstValueAndBriefingPrompt) already
  // asks "what should I call you?" and, if the answer was a plausible name, persists it to
  // user_name before this chain ever starts. Asking again here is a redundant repeat of a
  // question the user already answered — and was the root cause of a real bug (a frustrated
  // re-answer like "I already said Sam" getting stored as the permanent display name instead of
  // just their name).
  if (getSetting(ownerId, "user_name")) {
    await askAfterName(ownerId, phone);
  } else {
    await askName(ownerId, phone);
  }
}

// The ask_name step — the very first question in the chain, right after the connected
// confirmation. A plain name is saved here and never forwarded to ordinary chat handling: it's
// not a request, just a name. Anything else that isn't a skip is, though — this step used to
// discard it, so someone who answered the first question with a question of their own ("what can
// you actually do?") got no answer at all, just the next scripted question. Skipping (or a blank
// reply) leaves no name saved; callers that personalize text (e.g. importantEmailAlerts.ts's
// alert copy) fall back to an unpersonalized form rather than requiring this.
export async function handleNameReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_name") return false;
  if (awaitingAssistantAnswer.has(ownerId)) return false;
  const phone = message.from;
  const name = message.text.trim().slice(0, 60);
  // A blank reply is nothing to save and nothing for the assistant to answer — treat it as a skip
  // rather than forwarding an empty message.
  if (!name || isSkip(message.text)) {
    await askAfterName(ownerId, phone);
    return true;
  }
  // Reject sentence-shaped replies (e.g. "I already said Sam") rather than storing them
  // verbatim as the permanent display name — see plausibleName.ts.
  if (name && isPlausibleName(name)) {
    setSetting(ownerId, "user_name", name);
    await askAfterName(ownerId, phone);
    return true;
  }
  // Not a name and not a skip: hand it to the real assistant and move on once it's answered,
  // the same way ask_first_task treats a genuine request.
  await forwardToAssistantThenAdvance(ownerId, message, askAfterName);
  return true;
}

// A question back ("what can you do?") is a request for the assistant, not a business description.
const QUESTION = /\?\s*$|^\s*(what|how|why|who|when|where|can|could|do|does|is|are|will|would|should)\b/i;

// The ask_business step. A description is saved (capped, like the profile tool) and the chain
// moves on; a skip or blank moves on without saving (the assistant asks again later, in chat);
// a question goes to the assistant and the chain waits for its answer.
export async function handleBusinessReply(ownerId: number, message: IncomingWhatsAppMessage): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_business") return false;
  if (awaitingAssistantAnswer.has(ownerId)) return false;
  const phone = message.from;
  const answer = message.text.trim();
  if (!answer || isSkip(answer)) {
    await askFirstReceipt(ownerId, phone);
    return true;
  }
  if (QUESTION.test(answer)) {
    await forwardToAssistantThenAdvance(ownerId, message, askFirstReceipt);
    return true;
  }
  saveBusinessDescription(ownerId, answer);
  await askFirstReceipt(ownerId, phone);
  return true;
}

// The ask_first_receipt step, for typed replies. A photo or PDF isn't handled here: it goes through
// normal document handling (which files it in their books), and firstReceiptFollowUp below moves
// the chain on once the assistant has confirmed it.
export async function handleFirstReceiptReply(ownerId: number, message: IncomingWhatsAppMessage): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_first_receipt") return false;
  if (awaitingAssistantAnswer.has(ownerId)) return false;
  await advancePastFreeTextStep(ownerId, message, "No problem — you can send receipts any time.", askBriefing);
  return true;
}

// Passed by whatsappRoutes.ts's handleMedia as the assistant's afterReply while ask_first_receipt
// is pending, so the briefing question follows the "added to your books" reply instead of racing
// it. The step stays pending until then (the assistant's onboarding note depends on it), and is
// claimed inside the callback, so two photos sent together still advance the chain only once.
export function firstReceiptFollowUp(ownerId: number, phone: string): (() => Promise<void>) | undefined {
  if (getPendingSetup(ownerId) !== "ask_first_receipt") return undefined;
  return async () => {
    if (!claimPendingSetup(ownerId, "ask_first_receipt")) return;
    await askBriefing(ownerId, phone);
  };
}

// Owners whose message has been handed to the assistant but not answered yet. Their follow-up
// texts in the meantime go to the assistant like any other message (folded into the same reply
// when they arrive in time) instead of counting as another reply to the outstanding step. In
// memory only: after a restart the step is simply still pending and the next text re-enters it.
const awaitingAssistantAnswer = new Set<number>();

// Forward a real message to ordinary chat handling (a real answer, from the real assistant) and
// call `next` — which sends the following scripted question — only once that answer has been
// sent. handleText only queues the message behind a debounce, so calling `next` straight after it
// used to send the next question first, and moved the pending step on before the assistant ran,
// so it never saw its onboarding note.
async function forwardToAssistantThenAdvance(
  ownerId: number,
  message: IncomingWhatsAppMessage & { kind: "text" },
  next: (ownerId: number, phone: string) => Promise<void>
): Promise<void> {
  const phone = message.from;
  awaitingAssistantAnswer.add(ownerId);
  const advance = async () => {
    awaitingAssistantAnswer.delete(ownerId);
    await next(ownerId, phone);
  };
  try {
    await handleText(ownerId, phone, message.text, message.messageId, message.quotedMessageId, message.forwarded, advance);
  } catch (err) {
    // Nothing was queued, so `advance` will never be called for us — don't strand the chain.
    console.error(`postConnectSetup: forwarding a setup-step message failed for owner ${ownerId}`, err);
    await advance();
  }
}

// The ask_first_task step's own version: a "carry on" reply is acknowledged and the chain moves
// straight on, anything else is a real request and goes to the assistant first.
async function advancePastFreeTextStep(
  ownerId: number,
  message: IncomingWhatsAppMessage & { kind: "text" },
  skipReply: string,
  next: (ownerId: number, phone: string) => Promise<void>
): Promise<void> {
  const phone = message.from;
  // Not just isSkip: a natural "let's just set up" has to count as carrying on too, or it gets
  // forwarded to the assistant as a request it has nothing real to answer — see setupIntent.ts.
  if (await wantsToContinueSetup(ownerId, message.text)) {
    await reply(phone, skipReply);
    await next(ownerId, phone);
    return;
  }
  await forwardToAssistantThenAdvance(ownerId, message, next);
}

// The ask_first_task step — see module comment. Only applies while that step is pending and the
// incoming message is plain text; anything else (media, a button tap) is left for normal
// handling and the step stays pending until a text reply arrives.
export async function handleFirstTaskReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_first_task") return false;
  if (awaitingAssistantAnswer.has(ownerId)) return false;
  await advancePastFreeTextStep(
    ownerId,
    message,
    "No worries — let's finish setting up.",
    askBriefing
  );
  return true;
}

// Called from whatsappRoutes.ts's handleIncoming, before falling through to the real assistant.
// Handles the two remaining yes/no button steps (ask_briefing, ask_teams). Returns true if this
// message was consumed (an interactive tap matching the outstanding question), false otherwise
// (nothing pending, a stray/late tap on an old button, or ordinary text/media that should go to
// the assistant as usual).
export async function handlePostConnectSetupReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "interactive") return false;
  const step = getPendingSetup(ownerId);
  if (step !== "ask_briefing" && step !== "ask_teams") return false;

  const ids = BUTTON_IDS[step];
  if (message.buttonId !== ids.yes && message.buttonId !== ids.no) return false;
  // Claim the step before acting on it. Two quick taps are two distinct webhook messages, so
  // whatsappRoutes' alreadyProcessed doesn't dedupe them — both used to run the branch below,
  // writing the preference twice and sending the closing message twice. The loser of the race is
  // reported as unhandled, which is what a stray/late tap already gets.
  if (!claimPendingSetup(ownerId, step)) return false;
  const yes = message.buttonId === ids.yes;
  const phone = message.from;

  switch (step) {
    case "ask_briefing": {
      const current = getBriefingSettings(ownerId);
      // Business users were offered a money update, not headlines, so yes doesn't switch news on.
      const business = usesBusinessOnboarding(ownerId);
      saveBriefingSettings(ownerId, {
        ...current,
        proactive: yes,
        ...(yes && !business ? { includeNews: true, topics: DEFAULT_BRIEFING_TOPICS } : {}),
      });
      if (yes) {
        // Stamped immediately so the scheduler (runDailyCheckForUser in scheduler.ts) treats
        // today as already sent — the first real proactive briefing goes out tomorrow morning,
        // not minutes after onboarding finishes.
        setSetting(ownerId, "last_proactive_send_date", userLocalClock(ownerId).dateKey);
        if (business) {
          await reply(
            phone,
            "Great — I'll message you each morning, and on Mondays you'll get last week's money in and out too."
          );
        } else {
          await announceBriefingDefault(phone);
        }
      }
      await askTeamsOrFinish(ownerId, phone);
      return true;
    }
    case "ask_teams": {
      setToolEnabled(ownerId, "teams", yes);
      // No clearPendingSetup — claimPendingSetup above already removed the row.
      await sendClosingMessage(phone);
      return true;
    }
  }
}
