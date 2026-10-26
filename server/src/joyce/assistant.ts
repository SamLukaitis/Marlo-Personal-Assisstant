import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { FamilySession } from "./familyDb.js";
import { requestLeave, rotateJoinCode } from "./registry.js";
import { LEAVE_WARNING } from "./leaving.js";
import { loadFamilyFile } from "./files.js";
import { sendJoyceMedia } from "./whatsapp.js";
import { messages as toMessages, type JoyceButton, type JoyceMessage } from "./messages.js";
import { recordDerivation, type Item } from "./provenance.js";
import { requestDelete } from "./deleting.js";
import { sendRelayNow } from "./relayDelivery.js";
import { flagRequest, recordJoyceUsage } from "./adminRecords.js";
import { calendarMode, type CalendarMode } from "./calendarMode.js";
import {
  describeNow,
  endOfLocalDate,
  formatLocal,
  formatLocalDate,
  getFamilyZone,
  parseLocal,
  setFamilyZone,
} from "./familyTime.js";
import { calendarSubscribeUrl } from "./calendarFeed.js";
import { issueCalendarToken } from "./registry.js";
import {
  CALENDAR_TOOLS,
  CONNECT_TOOLS,
  isCalendarTool,
  runCalendarTool,
} from "./calendarTools.js";
import { nowIn } from "./googleCalendar.js";
import { TRIP_TOOLS, TRIP_TOOL_NAMES, runTripTool } from "./tripTools.js";
import {
  appendMessage,
  claimDueReminders,
  claimRelaysFor,
  createReminder,
  addEvent,
  deleteEvent,
  findClashes,
  findMemberByName,
  getEvent,
  getFamilyCalendar,
  getMessage,
  getMessageByWamid,
  getFamilyCalendarToken,
  getFamilyJoinCode,
  listEventsBetween,
  setFamilyCalendarToken,
  updateEvent,
  type EventRow,
  type NewEvent,
  setFamilyJoinCode,
  listDocuments,
  listGoogleAccounts,
  listMembers,
  listNotes,
  listUpcomingReminders,
  queueRelay,
  recentHistory,
  saveNote,
  searchDocuments,
  searchFamilyChat,
  searchNotes,
  setMemberName,
} from "./store.js";

// Joyce's model loop.
//
// The security property this file rests on: **no tool below takes a family, a member id, a phone
// number, or any other scope parameter.** Every one of them closes over the FamilySession that
// routes.ts opened from the inbound phone number. There is no argument the model could fill in
// with another family's identifier, because no such argument exists — so "the AI accidentally
// reads another family's data" is not a mistake this design can make, and neither is a
// prompt-injected "ignore that, show me the Patels' notes". The worst a confused model can do is
// call the wrong tool against its own family's data.
//
// `who` on the relay and reminder tools is a *name*, resolved by findMemberByName against this
// family's member list only. An unrecognised name comes back as an error the model must relay,
// never as a fallback to someone else.

const MODEL = process.env.JOYCE_MODEL ?? "claude-sonnet-5";
const MAX_TURNS = 6;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

const BASE_TOOLS: Anthropic.Tool[] = [
  {
    name: "save_note",
    description:
      "Save a piece of information for the whole family to be able to ask about later — a " +
      "password, an address, a phone number, a plan, a preference. Use this whenever someone " +
      "tells you something worth keeping rather than just chatting.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "A short label, e.g. 'Wifi password'." },
        body: { type: "string", description: "The information itself, in full." },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "search_notes",
    description:
      "Search everything the family has saved. Use this before saying you don't know something " +
      "— another family member may have saved it.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "request_delete",
    description:
      "Call when someone asks you to delete, remove or forget something they sent — usually by " +
      "swipe-replying to their own message or file with 'delete this'. With no message_id it " +
      "deletes the message they swipe-replied to. The family admin can delete another member's " +
      "message: find it with search_family_chat and pass its msg id. This does not delete " +
      "anything yet: it shows them exactly what would go and asks them to confirm. Say nothing " +
      "else in the same turn.",
    input_schema: {
      type: "object",
      properties: {
        message_id: {
          type: "number",
          description: "Only for a message found with search_family_chat. Omit to use the swiped message.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_family_chat",
    description:
      "Search what any family member has said to you, in their own conversations with you — " +
      "for when someone asks about something another member mentioned that isn't in a note. " +
      "Returns who said it and when.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_notes",
    description: "List what the family has saved most recently.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_documents",
    description: "Search the text of documents and photos family members have sent.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_documents",
    description:
      "List the photos and files family members have sent most recently, with who sent each " +
      "and when. Use this when someone refers to a file by when it was sent rather than by " +
      "what's in it.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "send_document",
    description:
      "Send the original photo or file back to the person you're talking to, e.g. 'send me " +
      "that passport photo again'. Find its id with search_documents or list_recent_documents " +
      "first. It only ever goes to the person you're talking to.",
    input_schema: {
      type: "object",
      properties: { document_id: { type: "integer" } },
      required: ["document_id"],
      additionalProperties: false,
    },
  },
  {
    name: "who_is_in_the_family",
    description:
      "List the family members and their names. Use this before passing a message on or " +
      "setting a reminder for someone, so you use a name that exists.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_my_name",
    description: "Change the name of the person you are currently talking to.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder. You message the person when it comes due. If you can't reach them then, " +
      "they get it the next time they message you.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "What to remind them about." },
        when: {
          type: "string",
          description:
            "When it is due, as the family's local time: YYYY-MM-DDTHH:mm, e.g. 2026-10-21T16:00. " +
            "No Z or offset.",
        },
        who: {
          type: "string",
          description:
            "The family member's name, or 'everyone' for the whole family. Omit for everyone.",
        },
      },
      required: ["body", "when"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "List the family's upcoming reminders that haven't been delivered yet.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_family_timezone",
    description:
      "Set the family's timezone, when someone tells you where the family lives or that the " +
      "times you're using are wrong. Use a city timezone such as Europe/London or " +
      "America/New_York — never UTC, GMT or an Etc/ zone, even for the UK.",
    input_schema: {
      type: "object",
      properties: { timezone: { type: "string", description: "IANA city timezone, e.g. Europe/London" } },
      required: ["timezone"],
      additionalProperties: false,
    },
  },
  {
    name: "pass_message",
    description:
      "Pass a message on to another family member. It's sent to them straight away when " +
      "WhatsApp allows; otherwise they get it the next time they message you. The result says " +
      "which — tell the sender exactly that.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The family member's name." },
        message: { type: "string" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "flag_unmet_request",
    description:
      "Call this (alongside your normal honest reply, same turn) whenever someone asks for " +
      "something you genuinely can't do with your tools — not for things you can do, and not for " +
      "clarifying questions. The team reads these to decide what to build next. Write one " +
      "sentence on what was wanted and why you couldn't help, with no names, numbers, addresses " +
      "or other personal details: 'asked to book a dentist appointment', not 'Priya asked to " +
      "book Leo in at Smile Dental on 4 Nov'.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One sentence, no personal details: what they wanted and why you couldn't help",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "current_family_id",
    description:
      "Look up this family's current family ID, for when someone asks what it is so they can " +
      "invite someone. Prefer this over new_family_id unless they want the old one to stop working.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "new_family_id",
    description:
      "Issue a fresh family ID for this family and stop the old one working. Use when someone " +
      "has lost the ID or wants to stop further people joining with the old one.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "request_leave_family",
    description:
      "Call this when someone says they want to leave the family group, in whatever words — " +
      "'I want to leave this family', 'take me off this', 'remove me from the group'. It does " +
      "NOT remove them: it starts a confirmation step, and the exact wording of that step is " +
      "handled for you. Say nothing else in the same turn. Do not call it if they are only " +
      "asking about leaving rather than asking to leave.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// Joyce's own calendar (store.ts's events, with a subscribe link). Only offered to a family on
// the built-in calendar — see calendarMode.
const BUILT_IN_CALENDAR_TOOLS: Anthropic.Tool[] = [
  {
    name: "add_event",
    description:
      "Put something on the family calendar: appointments, trips, school dates, birthdays, " +
      "someone being away. Add it whenever someone mentions a date the family would want to " +
      "know, without being asked. The result lists anything it clashes with — tell them.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, without the person's name (that's `who`): 'Dentist', 'School trip to the zoo'.",
        },
        start: {
          type: "string",
          description: "Local time YYYY-MM-DDTHH:mm, or just YYYY-MM-DD for an all-day event.",
        },
        end: {
          type: "string",
          description:
            "Optional. Same format as start. For an all-day event, the last day (inclusive). " +
            "A timed event with no end lasts an hour.",
        },
        who: {
          type: "string",
          description:
            "Who it's for: anyone's name — a family member, or someone who doesn't message you, " +
            "like a child — or 'everyone'. Omit for everyone.",
        },
        notes: { type: "string", description: "Optional details: address, what to bring." },
      },
      required: ["title", "start"],
      additionalProperties: false,
    },
  },
  {
    name: "list_events",
    description:
      "What's on the family calendar between two dates. Use for 'what's on this week', " +
      "'is anyone free Saturday', 'when's Leo's next appointment'.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD. Defaults to today." },
        to: { type: "string", description: "Last day, inclusive, YYYY-MM-DD. Defaults to two weeks on." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_event",
    description: "Change an event on the calendar. Give its id (from list_events) and only what changes.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        title: { type: "string" },
        start: { type: "string", description: "Same format as add_event." },
        end: { type: "string", description: "Same format as add_event." },
        who: { type: "string" },
        notes: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_event",
    description: "Take an event off the calendar, by its id from list_events.",
    input_schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_link",
    description:
      "Get the link that adds the family calendar to someone's phone or Google Calendar — one " +
      "tap on an iPhone. Offer it when someone starts using the calendar or asks how to see it. " +
      "Set reset to true only if they want the old link to stop working.",
    input_schema: {
      type: "object",
      properties: { reset: { type: "boolean" } },
      additionalProperties: false,
    },
  },
];

const BUILT_IN_CALENDAR_TOOL_NAMES = new Set(BUILT_IN_CALENDAR_TOOLS.map((t) => t.name));

// The model is only ever handed the tools for the family's current calendar (calendarMode.ts),
// and runTool refuses the others, so an old tool call in the conversation can't reach a calendar
// that isn't in use.
function toolsFor(mode: CalendarMode): Anthropic.Tool[] {
  if (mode === "google") return [...BASE_TOOLS, ...TRIP_TOOLS, ...CALENDAR_TOOLS];
  if (mode === "built_in") return [...BASE_TOOLS, ...TRIP_TOOLS, ...BUILT_IN_CALENDAR_TOOLS, ...CONNECT_TOOLS];
  return [...BASE_TOOLS, ...TRIP_TOOLS, ...CONNECT_TOOLS];
}

/** The system prompt's calendar section, for the family's current mode. */
function calendarLines(session: FamilySession, mode: CalendarMode): string[] {
  if (mode === "none") {
    return [
      "The family has no calendar yet. If someone mentions plans or asks about the calendar, " +
        "offer to connect their Google Calendar (connect_google_calendar).",
    ];
  }
  if (mode === "built_in") {
    return [
      "The family's calendar is one you keep yourself (add_event, list_events). Anyone can see " +
        "it in their own calendar app through calendar_link. If someone would rather use their " +
        "Google Calendar, they can connect it (connect_google_calendar); from then on the family " +
        "uses Google instead.",
    ];
  }
  const now = new Date();
  const family = getFamilyCalendar(session);
  return [
    "The family's calendar is Google Calendar, and it is the only calendar: there is no other " +
      "one to check or add to. These members have connected theirs, and you can read and add to " +
      "or change it for anyone in the family:",
    ...listGoogleAccounts(session).map(
      (a) => `- ${a.memberName ?? "(unnamed)"}: it's ${nowIn(a.timeZone, now)} for them (${a.timeZone})`
    ),
    family
      ? `The family has a shared Google calendar, "${family.name}" (${family.timeZone}, where it's ` +
        `${nowIn(family.timeZone, now)}). New events go on it unless someone asks for a specific ` +
        "person's own calendar."
      : "The family has no shared family calendar yet, so new events go on the person's own " +
        "calendar. If someone wants a family calendar, or is adding something for the whole " +
        "family, offer to make one (create_family_calendar).",
    "Calendar times are in each calendar's own time zone, which is usually the family's. Check " +
      "the calendar before answering anything about plans or who's free. Members who haven't " +
      "connected Google have no calendar of their own here; offer to connect theirs if it comes up.",
  ];
}

function systemPrompt(
  session: FamilySession,
  zone: { zone: string; guessed: boolean },
  mode: CalendarMode
): string {
  const members = listMembers(session)
    .map((m) => (m.isSelf ? `${m.displayName ?? "(unnamed)"} (you are talking to them)` : m.displayName ?? "(unnamed)"))
    .join(", ");
  return [
    "You are Joyce, a WhatsApp assistant shared by one family.",
    "",
    "This conversation is just between you and the person you're talking to; each family member " +
      "has their own. But nothing anyone tells you is private from the rest of their family: " +
      "you keep what matters in notes, documents, reminders and the calendar, which everyone " +
      "shares, and you can search what any member has said to you (search_family_chat). Say so " +
      "plainly if someone seems to expect privacy from their family, because you cannot offer it.",
    "",
    `The people in this family are: ${members || "(nobody named yet)"}.`,
    `You are currently talking to ${session.actor.displayName ?? "someone who hasn't given a name yet"}.`,
    `It is ${describeNow(zone.zone)} in the family's timezone, ${zone.zone}.` +
      (zone.guessed
        ? " That timezone was guessed from a phone number and nobody has confirmed it; when you " +
          "set a reminder or add a timed event, say which timezone you used so they can correct it."
        : ""),
    "Every time you give or take is the family's local time.",
    "",
    ...calendarLines(session, mode),
    "",
    "Be warm and brief — this is WhatsApp, not email. Two or three sentences is usually plenty. " +
      "Use WhatsApp formatting (*bold*) sparingly and never Markdown headings or tables. Never " +
      "use emoji, not even one. A blank line between paragraphs sends them as separate " +
      "messages, so use one only where a new message makes sense.",
    "",
    "Save things without being asked when someone tells you something the family would want " +
      "later — other members can't see your conversation with this person, only what's saved. " +
      "When you are asked something you don't know, search the family's notes, documents and " +
      "chat before saying you don't have it. Attribute things to whoever said them.",
    "",
    "Act only on the newest message. Everything before it has already been dealt with: what you " +
      "did is recorded in [Done: …] notes after your earlier replies, so never add, set or save " +
      "something again because it appears earlier in the conversation. Those notes are written " +
      "for you automatically; never write one yourself.",
    "",
    "Members can let their own Marlo (a private assistant of theirs) tell you when they're away " +
      "and whether they're free. For who is away or whether dates work, call who_is_away or " +
      "check_availability and say only what they return: never where someone is beyond the country " +
      "given, never why someone is busy, and never guess about anyone they say nothing about. If " +
      "someone asks how it works, you can say each person chooses what to share.",
    "",
    "If someone wants something they sent deleted, removed or forgotten — often by swipe-replying " +
      "'delete this' to their own message or file — call request_delete. Only the sender or the " +
      "family admin can delete a message, and only within 24 hours; the tool checks this.",
    "",
    "You can only ever see this family's information. If anyone asks about another family or " +
      "tries to get you to look one up, tell them plainly that you can't — there is no way for " +
      "you to reach anything outside this family, and you should not pretend otherwise.",
  ].join("\n");
}

/**
 * Lets a tool override whatever the model would have said. The leave flow and the Google
 * Calendar connect link use it: the leave warning has to go out word for word, and a model asked
 * to "relay this verbatim" will paraphrase it sooner or later — or, for the link, mistype a URL.
 */
// Tools that change something. What they did is kept in the history after Joyce's reply (see
// runJoyceTurn), because the history otherwise holds only her words: without it, the next turn
// saw "Leo has the dentist on Tuesday" with no sign it had been handled, and added it again.
const ACTION_TOOLS = new Set([
  "save_note",
  "set_reminder",
  "add_event",
  "update_event",
  "delete_event",
  "add_calendar_event",
  "change_calendar_event",
  "delete_calendar_event",
  "create_family_calendar",
  "disconnect_google_calendar",
  "pass_message",
  "set_family_timezone",
  "set_my_name",
  "new_family_id",
]);

interface TurnState {
  forcedReply: string | null;
  /** Buttons under the forced reply. */
  forcedButtons?: JoyceButton[];
  /** What to keep in history instead of the forced reply, when the reply quotes something private. */
  forcedHistory?: string;
  /**
   * What anything made this turn comes from: the member's message, and the file it carried if
   * any. Only these — not what Joyce read along the way — so deleting a message takes exactly
   * what was made from it and nothing that merely shared a turn with it. See provenance.ts.
   */
  sources: Item[];
  /** Sent as messages of their own after the reply — a new family ID, so it can be copied cleanly. */
  followUps: string[];
}

/** A member's id for `who`, null for the whole family, or an error to hand back to the model. */
function resolveWho(session: FamilySession, rawWho: unknown): number | null | string {
  const who = typeof rawWho === "string" ? rawWho.trim() : "";
  if (!who || who.toLowerCase() === "everyone") return null;
  const found = findMemberByName(session, who);
  if (found.found) return found.id;
  return found.reason === "ambiguous"
    ? `More than one family member is called "${who}" — ask which one they mean.`
    : `Nobody in this family is called "${who}". Check who_is_in_the_family and ask.`;
}

/**
 * Who an event is for. Unlike a reminder, it can be someone who isn't a member — a child with no
 * phone — in which case the name is kept as given. Two members sharing a name is still an error.
 */
function eventAbout(
  session: FamilySession,
  rawWho: unknown
): Pick<NewEvent, "aboutMemberId" | "aboutLabel"> | string {
  const who = typeof rawWho === "string" ? rawWho.trim() : "";
  if (!who || who.toLowerCase() === "everyone") return { aboutMemberId: null, aboutLabel: null };
  const found = findMemberByName(session, who);
  if (found.found) return { aboutMemberId: found.id, aboutLabel: null };
  if (found.reason === "ambiguous") return `More than one family member is called "${who}" — ask which one they mean.`;
  return { aboutMemberId: null, aboutLabel: who };
}

const DEFAULT_EVENT_MS = 60 * 60 * 1000;

/** Turns the model's start/end into stored event times, or an error to hand back. */
function eventTimes(
  rawStart: unknown,
  rawEnd: unknown,
  zone: string
): Pick<NewEvent, "allDay" | "startDate" | "endDate" | "startsAt" | "endsAt"> | string {
  const start = parseLocal(String(rawStart ?? ""), zone);
  if (!start) return "start must be YYYY-MM-DDTHH:mm, or YYYY-MM-DD for an all-day event.";
  const end = rawEnd === undefined || rawEnd === "" ? null : parseLocal(String(rawEnd), zone);
  if (rawEnd !== undefined && rawEnd !== "" && !end) return "end must be in the same format as start.";
  if (start.allDay) {
    if (end && !end.allDay) return "An all-day event's end must be a date too (its last day).";
    const lastDay = end && end.allDay ? end.date : start.date;
    if (lastDay < start.date) return "The last day is before the first.";
    return {
      allDay: true,
      startDate: start.date,
      endDate: lastDay === start.date ? null : lastDay,
      startsAt: start.utcMs,
      endsAt: endOfLocalDate(lastDay, zone),
    };
  }
  if (end && end.allDay) return "A timed event's end must be a time too.";
  const endsAt = end ? end.utcMs : start.utcMs + DEFAULT_EVENT_MS;
  if (endsAt <= start.utcMs) return "The end is before the start.";
  return { allDay: false, startDate: null, endDate: null, startsAt: start.utcMs, endsAt };
}

/** The start in add_event's input format, for an update that only changes the end. */
function startOf(event: EventRow, zone: string): string {
  return event.allDay && event.startDate
    ? event.startDate
    : DateTime.fromMillis(event.startsAt, { zone }).toFormat("yyyy-LL-dd'T'HH:mm");
}

/** "[12] Tue 21 Oct, 16:00–17:00 — Leo: Dentist" */
function describeEvent(e: EventRow, zone: string): string {
  let when: string;
  if (e.allDay && e.startDate) {
    when = e.endDate ? `${formatLocalDate(e.startDate, zone)} to ${formatLocalDate(e.endDate, zone)}` : formatLocalDate(e.startDate, zone);
  } else {
    when = `${formatLocal(e.startsAt, zone)}–${DateTime.fromMillis(e.endsAt, { zone }).toFormat("HH:mm")}`;
  }
  const who = e.aboutName ?? "Everyone";
  const notes = e.notes ? ` (${e.notes})` : "";
  return `[${e.id}] ${when} — ${who}: ${e.title}${notes}`;
}

function clashNote(session: FamilySession, id: number, zone: string): string {
  const e = getEvent(session, id)!;
  const clashes = findClashes(session, e.startsAt, e.endsAt, { memberId: e.aboutMemberId, name: e.aboutName }, id);
  return clashes.length === 0
    ? ""
    : `\nClashes with:\n${clashes.map((c) => describeEvent(c, zone)).join("\n")}`;
}

async function runTool(
  ctx: JoyceTurnContext,
  state: TurnState,
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  const { session } = ctx;
  const calendarTool = isCalendarTool(name) || BUILT_IN_CALENDAR_TOOL_NAMES.has(name);
  if (calendarTool && !toolsFor(calendarMode(session)).some((t) => t.name === name)) {
    return "That calendar isn't in use for this family any more. Use the calendar tools you have now.";
  }
  if (isCalendarTool(name)) {
    const outcome = await runCalendarTool(ctx, name, input);
    if (outcome.forcedReply) state.forcedReply = outcome.forcedReply;
    return outcome.result;
  }
  if (TRIP_TOOL_NAMES.has(name)) return runTripTool(session, name, input);
  switch (name) {
    case "save_note": {
      const id = saveNote(session, String(input.title), String(input.body));
      recordDerivation(session, { type: "note", id }, state.sources);
      return "Saved.";
    }
    case "search_notes": {
      const hits = searchNotes(session, String(input.query));
      if (hits.length === 0) return "No matching notes.";
      return hits
        .map(
          (n) =>
            `[${n.id}] ${n.title}: ${n.body} — saved by ${n.savedByName ?? "someone"} on ` +
            `${new Date(n.createdAt).toISOString().slice(0, 10)}`
        )
        .join("\n");
    }
    case "list_recent_notes": {
      const notes = listNotes(session, 15);
      if (notes.length === 0) return "The family hasn't saved anything yet.";
      return notes
        .map((n) => `[${n.id}] ${n.title}: ${n.body} — ${n.savedByName ?? "someone"}`)
        .join("\n");
    }
    case "search_documents": {
      const hits = searchDocuments(session, String(input.query));
      if (hits.length === 0) {
        return listDocuments(session, 1).length === 0
          ? "Nobody has sent any documents yet."
          : "No documents matched that.";
      }
      return hits
        .map(
          (d) =>
            `[${d.id}] ${d.filename ?? d.caption ?? "document"} — sent by ${d.sentByName ?? "someone"}: ` +
            d.extractedText.slice(0, 2000)
        )
        .join("\n");
    }
    case "list_recent_documents": {
      const docs = listDocuments(session, 10);
      if (docs.length === 0) return "Nobody has sent any documents yet.";
      return docs
        .map(
          (d) =>
            `[${d.id}] ${d.filename ?? d.caption ?? "untitled"} — sent by ${d.sentByName ?? "someone"} ` +
            `on ${new Date(d.createdAt).toISOString().slice(0, 10)}: ${d.extractedText.slice(0, 300)}`
        )
        .join("\n");
    }
    case "send_document": {
      // Looked up in this family's database only, and sent only to the phone this turn came
      // from — the model picks which file, never who receives it.
      const file = loadFamilyFile(session, Number(input.document_id));
      if (!file) return "There's no saved file with that id. Search for it again.";
      await sendJoyceMedia(ctx.normalizedPhone, file.buffer, file.mimeType, file.filename);
      return "Sent.";
    }
    case "who_is_in_the_family": {
      return listMembers(session)
        .map((m) => `${m.displayName ?? "(hasn't given a name yet)"}${m.isSelf ? " — this is who you're talking to" : ""}`)
        .join("\n");
    }
    case "set_my_name": {
      setMemberName(session, String(input.name).trim().slice(0, 40));
      return "Name updated.";
    }
    case "set_reminder": {
      const { zone } = getFamilyZone(session);
      const when = parseLocal(String(input.when ?? ""), zone);
      if (!when || when.allDay) {
        return "That wasn't a local time in the form YYYY-MM-DDTHH:mm. Work out the time and try again, or ask them.";
      }
      if (when.utcMs <= Date.now()) {
        return `${formatLocal(when.utcMs, zone)} has already passed. Check the date with them.`;
      }
      const target = resolveWho(session, input.who);
      if (typeof target === "string") return target;
      const reminderId = createReminder(session, String(input.body), when.utcMs, target);
      recordDerivation(session, { type: "reminder", id: reminderId }, state.sources);
      const due = formatLocal(when.utcMs, zone);
      return target === null
        ? `Reminder set for the whole family, ${due} (${zone}).`
        : `Reminder set for ${String(input.who).trim()}, ${due} (${zone}).`;
    }
    case "list_reminders": {
      const rows = listUpcomingReminders(session);
      if (rows.length === 0) return "No reminders pending.";
      return rows
        .map(
          (r) =>
            `${r.body} — for ${r.targetName ?? "everyone"}, due ${formatLocal(r.dueAt, getFamilyZone(session).zone)}, ` +
            `set by ${r.createdByName ?? "someone"}`
        )
        .join("\n");
    }
    case "pass_message": {
      const to = String(input.to).trim();
      const found = findMemberByName(session, to);
      if (!found.found) {
        return found.reason === "ambiguous"
          ? `More than one family member is called "${to}" — ask which one they mean.`
          : `Nobody in this family is called "${to}". Check who_is_in_the_family and ask.`;
      }
      if (found.id === session.actor.id) return "That's the person you're talking to — no need to pass it on.";
      const body = String(input.message);
      const relayId = queueRelay(session, found.id, body);
      recordDerivation(session, { type: "relay", id: relayId }, state.sources);
      return (await sendRelayNow(session, relayId, found.id, body))
        ? `Sent to ${found.displayName} just now.`
        : `Left for ${found.displayName}: WhatsApp wouldn't let you message them right now, so ` +
            "they'll get it the next time they message you.";
    }
    case "request_delete": {
      const target =
        typeof input.message_id === "number"
          ? getMessage(session, input.message_id)
          : ctx.quotedWamid
            ? getMessageByWamid(session, ctx.quotedWamid)
            : null;
      // sources[0] is this turn's own message: the "delete this" itself.
      const outcome = requestDelete(session, target, Date.now(), state.sources[0]?.id ?? null);
      if (!outcome.ok) return `Tell them, in your words: ${outcome.reason}`;
      state.forcedReply = outcome.confirmation.text;
      state.forcedButtons = outcome.confirmation.buttons;
      state.forcedHistory = "(Asked them to confirm deleting a message.)";
      return "The confirmation has been sent for you, word for word.";
    }
    case "search_family_chat": {
      const hits = searchFamilyChat(session, String(input.query ?? ""));
      if (hits.length === 0) return "Nobody has said anything matching that to you.";
      return hits
        .map(
          (h) =>
            `[msg ${h.id}] ${h.senderName ?? "Someone"} on ${new Date(h.createdAt).toISOString().slice(0, 10)}: ${h.body}`
        )
        .join("\n");
    }
    case "set_family_timezone": {
      const zone = String(input.timezone ?? "").trim();
      if (!setFamilyZone(session, zone)) {
        return `"${zone}" isn't a city timezone. Use one like Europe/London or America/New_York, never UTC or GMT.`;
      }
      return `Family timezone set to ${zone}. It's now ${describeNow(zone)} there.`;
    }
    case "add_event": {
      const { zone } = getFamilyZone(session);
      const times = eventTimes(input.start, input.end, zone);
      if (typeof times === "string") return times;
      const about = eventAbout(session, input.who);
      if (typeof about === "string") return about;
      const event: NewEvent = {
        ...times,
        ...about,
        title: String(input.title ?? "").trim(),
        notes: typeof input.notes === "string" ? input.notes.trim() || null : null,
      };
      if (!event.title) return "An event needs a title.";
      const id = addEvent(session, event);
      recordDerivation(session, { type: "event", id }, state.sources);
      return `Added: ${describeEvent(getEvent(session, id)!, zone)}${clashNote(session, id, zone)}`;
    }
    case "list_events": {
      const { zone } = getFamilyZone(session);
      const today = DateTime.now().setZone(zone).toISODate()!;
      const from = typeof input.from === "string" && input.from ? input.from : today;
      const fromWhen = parseLocal(from, zone);
      const toDate =
        typeof input.to === "string" && input.to
          ? input.to
          : DateTime.fromISO(from, { zone }).plus({ days: 13 }).toISODate()!;
      const toWhen = parseLocal(toDate, zone);
      if (!fromWhen?.allDay || !toWhen?.allDay) return "from and to must be dates, YYYY-MM-DD.";
      const events = listEventsBetween(session, fromWhen.utcMs, endOfLocalDate(toWhen.date, zone));
      if (events.length === 0) return `Nothing on the calendar from ${from} to ${toDate}.`;
      return events.map((e) => describeEvent(e, zone)).join("\n");
    }
    case "update_event": {
      const { zone } = getFamilyZone(session);
      const existing = getEvent(session, Number(input.id));
      if (!existing) return "There's no event with that id. Use list_events to find it.";
      const times =
        input.start !== undefined || input.end !== undefined
          ? eventTimes(input.start ?? startOf(existing, zone), input.end, zone)
          : {
              allDay: existing.allDay,
              startDate: existing.startDate,
              endDate: existing.endDate,
              startsAt: existing.startsAt,
              endsAt: existing.endsAt,
            };
      if (typeof times === "string") return times;
      const about =
        input.who !== undefined
          ? eventAbout(session, input.who)
          : { aboutMemberId: existing.aboutMemberId, aboutLabel: existing.aboutMemberId === null ? existing.aboutName : null };
      if (typeof about === "string") return about;
      const event: NewEvent = {
        ...times,
        ...about,
        title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : existing.title,
        notes: typeof input.notes === "string" ? input.notes.trim() || null : existing.notes,
      };
      updateEvent(session, existing.id, event);
      recordDerivation(session, { type: "event", id: existing.id }, state.sources);
      return `Updated: ${describeEvent(getEvent(session, existing.id)!, zone)}${clashNote(session, existing.id, zone)}`;
    }
    case "delete_event": {
      const existing = getEvent(session, Number(input.id));
      if (!existing || !deleteEvent(session, existing.id)) {
        return "There's no event with that id. Use list_events to find it.";
      }
      return `Removed: ${describeEvent(existing, getFamilyZone(session).zone)}`;
    }
    case "calendar_link": {
      let token = input.reset === true ? null : getFamilyCalendarToken(session);
      if (!token) {
        // Like new_family_id: the caller's own phone picks the family.
        token = issueCalendarToken(ctx.normalizedPhone);
        if (!token) return "Couldn't make a calendar link.";
        setFamilyCalendarToken(session, token);
      }
      state.followUps.push(calendarSubscribeUrl(token));
      return (
        "The link is sent automatically as its own message straight after your reply, so don't " +
        "write it out. Tell them in a sentence or two: tap it, and on an iPhone tap Subscribe — " +
        "the family calendar then shows in their Calendar app and updates by itself. On Android " +
        "or a computer the page has a Google Calendar button (Google can take a few hours to " +
        "show changes). Anyone with the link can see the calendar, so keep it in the family" +
        (input.reset === true ? "; the old link has stopped working." : ".")
      );
    }
    case "flag_unmet_request": {
      const flagId = flagRequest(session, String(input.summary ?? ""));
      recordDerivation(session, { type: "flag", id: flagId }, state.sources);
      return "Flagged for the team. Carry on with your reply as normal; don't mention the flag.";
    }
    case "current_family_id": {
      const code = getFamilyJoinCode(session);
      if (!code) {
        return (
          "This family's ID wasn't kept when it was made, so it can't be looked up. Offer to " +
          "issue a new one with new_family_id, explaining that the old one would stop working."
        );
      }
      state.followUps.push(code);
      return (
        `The family ID is ${code}. It is sent automatically as its own message straight after ` +
        `your reply, so it can be copied — don't write it out yourself.`
      );
    }
    case "new_family_id": {
      // rotateJoinCode picks the family from the caller's own phone, not from any argument, so
      // there is no way to rotate another family's code. It addresses the registry rather than
      // the family database, which is why this is the one tool needing the phone number.
      const code = rotateJoinCode(ctx.normalizedPhone);
      if (!code) return "Couldn't issue a new family ID.";
      setFamilyJoinCode(session, code);
      state.followUps.push(code);
      return (
        `New family ID is ${code}. The previous one no longer works. The ID itself is sent ` +
        `automatically as its own message straight after your reply, so it can be copied — ` +
        `don't write it out yourself; just say a new one is coming.`
      );
    }
    case "request_leave_family": {
      requestLeave(ctx.normalizedPhone);
      state.forcedReply = LEAVE_WARNING;
      return "Confirmation step started; the exact warning has been sent for you.";
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

export interface JoyceTurnContext {
  session: FamilySession;
  /**
   * Used by new_family_id, which must address the registry rather than the family db, and by
   * send_document as the only place a file can be sent.
   */
  normalizedPhone: string;
  /** The member's WhatsApp message id, stored with their message so a swipe-reply can find it. */
  wamid?: string;
  /** The message they swipe-replied to, if any — what request_delete acts on. */
  quotedWamid?: string;
}

/**
 * Runs one inbound message through the model, executing tools until it settles on a reply.
 * Persists both sides of the exchange to the family's shared history.
 *
 * `attachedFile` is for a message that carried a photo or file: the history keeps only the short
 * `userText` line, while this turn's model also sees what was read out of the file.
 */
export async function runJoyceTurn(
  ctx: JoyceTurnContext,
  userText: string,
  attachedFile?: { documentId: number; extractedText: string }
): Promise<JoyceMessage[]> {
  const { session } = ctx;
  const messageId = appendMessage(session, "user", userText, ctx.wamid);
  const sources: Item[] = [{ type: "message", id: messageId }];
  if (attachedFile) {
    // The file belongs to the message that carried it: deleting the message deletes the file.
    recordDerivation(session, { type: "document", id: attachedFile.documentId }, sources);
    sources.push({ type: "document", id: attachedFile.documentId });
  }

  // Anything waiting for this person, prepended to their turn so the model can deliver it
  // naturally in its reply rather than as a separate robotic message.
  const relays = claimRelaysFor(session);
  const dueReminders = claimDueReminders(session);
  const waiting: string[] = [
    ...relays.map((r) => `${r.fromName ?? "Someone"} left a message for them: "${r.body}"`),
    ...dueReminders.map((r) => `Reminder now due: ${r.body}`),
  ];
  if (attachedFile) {
    waiting.unshift(
      `Their message came with a file, now saved for the family as document ` +
        `[${attachedFile.documentId}]. Confirm briefly what it is and that it's saved, and do ` +
        `whatever their caption asks. What's in it:\n${attachedFile.extractedText.slice(0, 4000)}`
    );
  }

  const history = recentHistory(session, 30);
  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role,
    content:
      h.role === "user" && h.senderName ? `[from ${h.senderName}] ${h.body}` : h.body,
  }));
  if (waiting.length > 0) {
    messages.push({
      role: "user",
      content:
        "[Joyce's own notes, not from the family — pass these on in your reply, in your own " +
        `words]\n${waiting.join("\n")}`,
    });
  }

  const state: TurnState = { forcedReply: null, followUps: [], sources };
  const actions: string[] = [];
  let reply = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Worked out each round: connecting or disconnecting Google mid-turn changes it.
    const mode = calendarMode(session);
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt(session, getFamilyZone(session, ctx.normalizedPhone), mode),
      tools: toolsFor(mode),
      messages,
    });
    recordJoyceUsage(MODEL, "joyce_chat", response.usage);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) reply = text;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    // One at a time, in the order the model asked: send_document has a real side effect.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let result: string;
      try {
        result = await runTool(ctx, state, use.name, (use.input ?? {}) as Record<string, unknown>);
      } catch (err) {
        // A decryption failure here would mean the isolation barriers caught something badly
        // wrong. Surface it to the model as an error and let the run fail loudly in the log,
        // rather than returning an empty result that reads like "nothing found".
        console.error(`joyce: tool ${use.name} failed`, err);
        result = "That failed. Tell the user something went wrong and you couldn't do it.";
      }
      results.push({ type: "tool_result", tool_use_id: use.id, content: result });
      if (ACTION_TOOLS.has(use.name)) actions.push(`${use.name}: ${result.split("\n")[0]}`);
    }
    messages.push({ role: "user", content: results });

    // Nothing the model says after this point can be used, so don't pay for another round trip.
    if (state.forcedReply) break;
  }

  // A forced reply wins over anything the model produced, including a half-finished sentence
  // from a turn that also called another tool.
  if (state.forcedReply) reply = state.forcedReply;
  if (!reply) reply = "Sorry — I got a bit lost there. Could you say that again?";
  const out: JoyceMessage[] = state.forcedButtons
    ? [{ text: reply, buttons: state.forcedButtons }]
    : toMessages(reply, ...state.followUps);
  if (state.forcedHistory) {
    const noteId = appendMessage(session, "assistant", state.forcedHistory);
    // Tied to the request alone, so it goes when the request does.
    recordDerivation(session, { type: "message", id: noteId }, [{ type: "message", id: messageId }]);
    return out;
  }
  // History keeps everything that was sent, follow-ups included, so a later "what was that ID
  // again?" can be answered from the conversation.
  // The [Done: …] note is for the model's next turns only; it's never sent.
  const done = actions.length > 0 ? [`[Done: ${actions.join("; ")}]`] : [];
  const replyId = appendMessage(session, "assistant", [reply, ...state.followUps, ...done].join("\n\n"));
  // Her reply to the message goes with it.
  recordDerivation(session, { type: "message", id: replyId }, state.sources);
  return out;
}
