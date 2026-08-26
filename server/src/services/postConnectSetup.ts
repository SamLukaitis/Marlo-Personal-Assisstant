// The yes/no button chain run right after OAuth connects a mailbox: daily briefing, then Teams
// chat search, then Schengen travel-day tracking. Replaces what used to be a single free-text
// prompt — see whatsappRegistration.ts's sendFirstValueAndBriefingPrompt, which now just kicks
// this off.
//
// Reuses the exact same save functions the assistant's own set_briefing_preferences/
// set_tool_enabled tools call — this is a different trigger for the same preferences, not a new
// preference-writing path.
//
// A registered number is routed straight to the real assistant (handleIncoming in
// whatsappRoutes.ts), not a registration-style state machine, so a button tap answering one of
// these questions needs its own small piece of state (pending_setup in db/store.ts) to be
// recognized instead of falling through as an unrecognized interactive message. Typed text always
// falls through to the assistant as normal — someone answering "yes" in words instead of tapping
// still works via ordinary conversation, just without the scripted button.
import {
  getPendingSetup,
  setPendingSetup,
  clearPendingSetup,
  setToolEnabled,
  type PostConnectSetupStep,
} from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings } from "./briefing.js";
import { sendWhatsAppMessage, sendWhatsAppReplyButtons } from "../providers/whatsapp.js";
import { hubListMessages, hubListEvents } from "./hub.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const BUTTON_IDS: Record<PostConnectSetupStep, { yes: string; no: string }> = {
  ask_briefing: { yes: "briefing_yes", no: "briefing_no" },
  ask_teams: { yes: "teams_yes", no: "teams_no" },
  ask_travel: { yes: "travel_yes", no: "travel_no" },
};

async function reply(phone: string, text: string): Promise<void> {
  await sendWhatsAppMessage(phone, text);
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

async function askTeams(ownerId: number, phone: string): Promise<void> {
  await sendWhatsAppReplyButtons(phone, "Want me to also search Microsoft Teams chats when you ask?", [
    { id: BUTTON_IDS.ask_teams.yes, title: "Yes" },
    { id: BUTTON_IDS.ask_teams.no, title: "No thanks" },
  ]);
  setPendingSetup(ownerId, "ask_teams");
}

async function askTravel(ownerId: number, phone: string): Promise<void> {
  await sendWhatsAppReplyButtons(phone, "Want me to track your Schengen travel days (90 days in any 180)?", [
    { id: BUTTON_IDS.ask_travel.yes, title: "Yes" },
    { id: BUTTON_IDS.ask_travel.no, title: "No thanks" },
  ]);
  setPendingSetup(ownerId, "ask_travel");
}

// Called from the OAuth callback (via whatsappRegistration.ts) once the mailbox is actually
// connected. Sends the "connected" confirmation + a best-effort first-value fact, then starts the
// button chain with the briefing question.
export async function startPostConnectSetup(ownerId: number, phone: string): Promise<void> {
  let fact = "";
  try {
    const [messages, events] = await Promise.all([
      hubListMessages(ownerId, { limit: 20 }).catch(() => []),
      hubListEvents(ownerId, 1).catch(() => []),
    ]);
    const unread = messages.filter((m) => m.unread).length;
    const parts: string[] = [];
    if (unread > 0) parts.push(`${unread} unread email${unread === 1 ? "" : "s"}`);
    if (events.length > 0) parts.push(`${events.length} thing${events.length === 1 ? "" : "s"} on today's calendar`);
    fact = parts.length ? ` I can already see ${parts.join(" and ")}.` : "";
  } catch {
    // best-effort — a missing first-value fact shouldn't block the confirmation message itself
  }

  await reply(phone, `Connected — I can see your inbox and your calendar.${fact}`);
  await askBriefing(ownerId, phone);
}

// Called from whatsappRoutes.ts's handleIncoming, before falling through to the real assistant.
// Returns true if this message was consumed (an interactive tap matching the outstanding
// question), false otherwise (nothing pending, a stray/late tap on an old button, or ordinary
// text/media that should go to the assistant as usual).
export async function handlePostConnectSetupReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "interactive") return false;
  const step = getPendingSetup(ownerId);
  if (!step) return false;

  const ids = BUTTON_IDS[step];
  if (message.buttonId !== ids.yes && message.buttonId !== ids.no) return false;
  const yes = message.buttonId === ids.yes;
  const phone = message.from;

  switch (step) {
    case "ask_briefing": {
      const current = getBriefingSettings(ownerId);
      saveBriefingSettings(ownerId, { ...current, proactive: yes });
      if (yes) {
        await reply(
          phone,
          "Want me to also include news, business headlines, or weather? Just tell me, or say skip."
        );
      }
      await askTeams(ownerId, phone);
      return true;
    }
    case "ask_teams": {
      setToolEnabled(ownerId, "teams", yes);
      await askTravel(ownerId, phone);
      return true;
    }
    case "ask_travel": {
      setToolEnabled(ownerId, "travel", yes);
      clearPendingSetup(ownerId);
      await reply(phone, "All set — ask me anything, or say \"help\" any time.");
      return true;
    }
  }
}
