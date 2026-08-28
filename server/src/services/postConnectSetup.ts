// The setup chain run right after OAuth connects a mailbox: a first-task check, then daily
// briefing (yes/no + content), then Teams chat search. See
// docs/superpowers/specs/2026-08-28-whatsapp-onboarding-redesign-design.md for the full design —
// this replaces the earlier version of this file, which asked about Schengen tracking
// unconditionally and stacked the briefing-content question directly behind the Teams question
// with no wait (see whatsappRegistration.ts's sendFirstValueAndBriefingPrompt, which kicks this
// off, still unchanged).
//
// Reuses the exact same save functions the assistant's own set_briefing_preferences/
// set_tool_enabled tools call — this is a different trigger for the same preferences, not a new
// preference-writing path.
//
// A registered number is routed straight to the real assistant (handleIncoming in
// whatsappRoutes.ts), not a registration-style state machine, so a button tap answering one of
// the yes/no questions here needs its own small piece of state (pending_setup in db/store.ts) to
// be recognized instead of falling through as an unrecognized interactive message. The two
// free-text steps (ask_first_task, ask_briefing_content) work differently: they wait for a real
// text reply (a "skip" or an actual request), forward a genuine request through ordinary chat
// handling (handleText, from chatDispatch.ts) so it gets a real answer, and only then advance the
// chain — never stacking the next scripted question behind an unanswered one.
import {
  getPendingSetup,
  setPendingSetup,
  clearPendingSetup,
  setToolEnabled,
  setSetting,
} from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings } from "./briefing.js";
import { todayKey } from "./dateKey.js";
import { sendWhatsAppMessage, sendWhatsAppReplyButtons } from "../providers/whatsapp.js";
import { hubListMessages, hubListEvents } from "./hub.js";
import { handleText } from "./chatDispatch.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const BUTTON_IDS: Record<"ask_briefing" | "ask_teams", { yes: string; no: string }> = {
  ask_briefing: { yes: "briefing_yes", no: "briefing_no" },
  ask_teams: { yes: "teams_yes", no: "teams_no" },
};

// Matches a reply that means "nothing else, move on" for either free-text step — deliberately
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

async function askBriefingContent(ownerId: number, phone: string): Promise<void> {
  await reply(
    phone,
    "Great — I'll send that each morning. Want me to also include *news*, *business headlines*, or *weather*? Just tell me, or say *skip*."
  );
  setPendingSetup(ownerId, "ask_briefing_content");
}

async function askTeams(ownerId: number, phone: string): Promise<void> {
  await sendWhatsAppReplyButtons(phone, "Want me to also search *Microsoft Teams* chats when you ask?", [
    { id: BUTTON_IDS.ask_teams.yes, title: "Yes" },
    { id: BUTTON_IDS.ask_teams.no, title: "No thanks" },
  ]);
  setPendingSetup(ownerId, "ask_teams");
}

async function sendClosingMessage(phone: string): Promise<void> {
  await reply(
    phone,
    '*All set!* ✅ Ask me anything, or say *help* any time.\n\n' +
      "One more thing — I'm still in testing, and my developers *Sam* and *Jake* want your feedback. " +
      "If something's off or you've got a request, just tell me and I'll pass it straight to them."
  );
}

// Called from the OAuth callback (via whatsappRegistration.ts) once the mailbox is actually
// connected. Sends the "connected" confirmation + a best-effort first-value fact, then starts the
// chain with the first-task check.
export async function startPostConnectSetup(ownerId: number, phone: string): Promise<void> {
  let fact = "";
  try {
    const [messages, events] = await Promise.all([
      hubListMessages(ownerId, { limit: 20 }).catch(() => []),
      hubListEvents(ownerId, 1).catch(() => []),
    ]);
    const unread = messages.filter((m) => m.unread).length;
    const parts: string[] = [];
    if (unread > 0) parts.push(`*${unread} unread email${unread === 1 ? "" : "s"}*`);
    if (events.length > 0) parts.push(`*${events.length} thing${events.length === 1 ? "" : "s"}* on today's calendar`);
    fact = parts.length ? ` I can already see ${parts.join(" and ")}.` : "";
  } catch {
    // best-effort — a missing first-value fact shouldn't block the confirmation message itself
  }

  await reply(phone, `*Connected!* ✅ I can see your inbox and your calendar.${fact}`);
  await askFirstTask(ownerId, phone);
}

// Shared by both free-text steps below: if it's a skip, acknowledge and hand off to `next`
// (which sends the following scripted question); otherwise forward the message to ordinary chat
// handling (a real answer, from the real assistant) and only then call `next` — so the next
// scripted question is never stacked behind one the user hasn't answered yet.
async function advancePastFreeTextStep(
  ownerId: number,
  message: IncomingWhatsAppMessage & { kind: "text" },
  skipReply: string,
  next: (ownerId: number, phone: string) => Promise<void>
): Promise<void> {
  const phone = message.from;
  if (isSkip(message.text)) {
    await reply(phone, skipReply);
  } else {
    await handleText(ownerId, phone, message.text);
  }
  await next(ownerId, phone);
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
  await advancePastFreeTextStep(
    ownerId,
    message,
    "No worries — let's finish setting up.",
    askBriefing
  );
  return true;
}

// The ask_briefing_content step — same shape as handleFirstTaskReply above, advancing to Teams
// once answered (skip or a real preference, via the assistant's set_briefing_preferences tool).
export async function handleBriefingContentReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "text") return false;
  if (getPendingSetup(ownerId) !== "ask_briefing_content") return false;
  await advancePastFreeTextStep(
    ownerId,
    message,
    "No worries, just the essentials then.",
    askTeams
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
      saveBriefingSettings(ownerId, { ...current, proactive: yes });
      if (yes) {
        // Stamped immediately so the scheduler (runDailyCheckForUser in scheduler.ts) treats
        // today as already sent — the first real proactive briefing goes out tomorrow morning,
        // not minutes after onboarding finishes.
        setSetting(ownerId, "last_proactive_send_date", todayKey());
        await askBriefingContent(ownerId, phone);
      } else {
        await askTeams(ownerId, phone);
      }
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
