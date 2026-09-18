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
  setToolEnabled,
  setSetting,
  getSetting,
  listAccounts,
} from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings, hasBriefingSettings } from "./briefing.js";
import { todayKey } from "./dateKey.js";
import { sendWhatsAppMessage, sendWhatsAppReplyButtons } from "../providers/whatsapp.js";
import { hubListMessages, hubListEvents } from "./hub.js";
import { handleText } from "./chatDispatch.js";
import { isPlausibleName } from "./plausibleName.js";
import { markOnboardingConnected } from "./onboardingAlertSuppression.js";
import { scanAndCurateImportantEmailsForOnboarding } from "./importantEmailAlerts.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";
import type { NewsTopic } from "../providers/news.js";

const BUTTON_IDS: Record<"ask_briefing" | "ask_teams", { yes: string; no: string }> = {
  ask_briefing: { yes: "briefing_yes", no: "briefing_no" },
  ask_teams: { yes: "teams_yes", no: "teams_no" },
};

// Matches a reply that means "nothing else, move on" for a free-text step — deliberately
// permissive (whole-message match, case-insensitive) rather than a substring search, so an actual
// request that happens to contain one of these words ("skip the intro and just tell me...") isn't
// misread as a skip.
const SKIP_PATTERN = /^(skip|no|no thanks|nothing|none|all good|i'?m good|let'?s continue|continue|finish setup)$/i;
function isSkip(text: string): boolean {
  return SKIP_PATTERN.test(text.trim());
}

async function reply(phone: string, text: string): Promise<void> {
  await sendWhatsAppMessage(phone, text);
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

async function askBriefing(ownerId: number, phone: string): Promise<void> {
  await sendWhatsAppReplyButtons(
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
  await sendWhatsAppReplyButtons(phone, "Want me to also search *Microsoft Teams* chats when you ask?", [
    { id: BUTTON_IDS.ask_teams.yes, title: "Yes" },
    { id: BUTTON_IDS.ask_teams.no, title: "No thanks" },
  ]);
  setPendingSetup(ownerId, "ask_teams");
}

// Note: this does NOT mention any important-mail backlog the proactive scanners may have found
// but held back (see onboardingAlertSuppression.ts) — an earlier version of this fix tried to
// report that here, but by the time this runs the backlog usually hasn't been discovered yet
// (the onboarding chain above typically finishes in well under a minute, while the scanners run
// on a global 5-minute tick unrelated to this moment). flushOnboardingAlertSummaryIfDue
// (scheduler.ts) reports it later instead, as its own message, once it's actually known.
async function sendClosingMessage(phone: string): Promise<void> {
  await reply(
    phone,
    '*All set!* ✅ Ask me anything, or say *help* any time.\n\n' +
      "One more thing — I'm still in testing, and my developers *Sam* and *Jake* want your feedback. " +
      "If something's off or you have a request for a new feature, just tell me and I'll send it over " +
      "to them to build ASAP. Any request I can't meet already gets flagged to them automatically :)"
  );
  // Its own message rather than a third paragraph above: the chain otherwise ends on a statement,
  // and someone who has just finished tapping through setup is left with no obvious next move. The
  // open question is the handoff into ordinary chat — pending_setup is already cleared by both
  // callers of this function, so whatever they reply goes straight to the assistant.
  await reply(phone, "Anything you need help with right now, or any questions?");
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
    const [messages, events, importantPreview] = await Promise.all([
      hubListMessages(ownerId, { limit: 20 }).catch(() => []),
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
      // A real, curated finding from the last 24 hours replaces the plain unread count entirely
      // — a user's own feedback: "instead of something like 20 unread emails it should say the
      // most important emails". Its own paragraph (it's multi-line), with the calendar fact
      // folded in as a trailing sentence rather than forced into the single joined sentence below.
      const more =
        importantPreview.moreCount > 0
          ? `\n...and ${importantPreview.moreCount} more — just ask any time.`
          : "";
      const calendarNote = calendarSentence ? ` I can also see ${calendarSentence}.` : "";
      fact = `\n\nAlready found a few things worth knowing about:\n${importantPreview.lines.join("\n")}${more}${calendarNote}`;
    } else {
      const parts: string[] = [];
      const unreadMessages = messages.filter((m) => m.unread);
      const unread = unreadMessages.length;
      // A single unread email names its actual subject instead of just a count — this and the
      // event sentence below are the one genuine "wow" moment in the whole chain when there's no
      // curated preview to lead with: Marlowe visibly already knows something real about the
      // user's day before they've answered a single question.
      if (unread === 1 && unreadMessages[0].subject) {
        parts.push(`*1 unread email* — "${unreadMessages[0].subject}"`);
      } else if (unread > 0) {
        parts.push(`*${unread} unread emails*`);
      }
      if (calendarSentence) parts.push(calendarSentence);
      fact = parts.length ? ` I can already see ${parts.join(" and ")}.` : "";
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
    await askFirstTask(ownerId, phone);
  } else {
    await askName(ownerId, phone);
  }
}

// The ask_name step — the very first question in the chain, right after the connected
// confirmation. Unlike the free-text step below (ask_first_task), a name reply is never forwarded
// to ordinary chat handling — it's not a request, just a name — so this doesn't use
// advancePastFreeTextStep. Skipping (or a blank reply) leaves no name saved;
// callers that personalize text (e.g. importantEmailAlerts.ts's alert copy) fall back to an
// unpersonalized form rather than requiring this.
export async function handleNameReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_name") return false;
  const phone = message.from;
  if (!isSkip(message.text)) {
    const name = message.text.trim().slice(0, 60);
    // Reject sentence-shaped replies (e.g. "I already said Sam") rather than storing them
    // verbatim as the permanent display name — see plausibleName.ts.
    if (name && isPlausibleName(name)) setSetting(ownerId, "user_name", name);
  }
  await askFirstTask(ownerId, phone);
  return true;
}

// Owners whose first-task request has been handed to the assistant but not answered yet. Their
// follow-up texts in the meantime go to the assistant like any other message (folded into the same
// reply when they arrive in time) instead of counting as another first-task reply. In memory only:
// after a restart the step is simply still pending and the next text re-enters it.
const awaitingFirstTaskAnswer = new Set<number>();

// Shared by the free-text step below: if it's a skip, acknowledge and hand off to `next`
// (which sends the following scripted question); otherwise forward the message to ordinary chat
// handling (a real answer, from the real assistant) and call `next` only once that answer has been
// sent. handleText only queues the message behind a debounce, so calling `next` straight after it
// used to send the next question first — and moved the pending step on before the assistant ran,
// so it never saw its ask_first_task onboarding note.
async function advancePastFreeTextStep(
  ownerId: number,
  message: IncomingWhatsAppMessage & { kind: "text" },
  skipReply: string,
  next: (ownerId: number, phone: string) => Promise<void>
): Promise<void> {
  const phone = message.from;
  if (isSkip(message.text)) {
    await reply(phone, skipReply);
    await next(ownerId, phone);
    return;
  }
  awaitingFirstTaskAnswer.add(ownerId);
  const advance = async () => {
    awaitingFirstTaskAnswer.delete(ownerId);
    await next(ownerId, phone);
  };
  try {
    await handleText(ownerId, phone, message.text, message.messageId, undefined, undefined, advance);
  } catch (err) {
    // Nothing was queued, so `advance` will never be called for us — don't strand the chain.
    console.error(`postConnectSetup: forwarding first-task request failed for owner ${ownerId}`, err);
    await advance();
  }
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
  if (awaitingFirstTaskAnswer.has(ownerId)) return false;
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
  const yes = message.buttonId === ids.yes;
  const phone = message.from;

  switch (step) {
    case "ask_briefing": {
      const current = getBriefingSettings(ownerId);
      saveBriefingSettings(ownerId, {
        ...current,
        proactive: yes,
        ...(yes ? { includeNews: true, topics: DEFAULT_BRIEFING_TOPICS } : {}),
      });
      if (yes) {
        // Stamped immediately so the scheduler (runDailyCheckForUser in scheduler.ts) treats
        // today as already sent — the first real proactive briefing goes out tomorrow morning,
        // not minutes after onboarding finishes.
        setSetting(ownerId, "last_proactive_send_date", todayKey());
        await announceBriefingDefault(phone);
      }
      await askTeamsOrFinish(ownerId, phone);
      return true;
    }
    case "ask_teams": {
      setToolEnabled(ownerId, "teams", yes);
      clearPendingSetup(ownerId);
      await sendClosingMessage(phone);
      return true;
    }
  }
}
