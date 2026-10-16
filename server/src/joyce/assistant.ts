import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import type { FamilySession } from "./familyDb.js";
import { requestLeave, rotateJoinCode } from "./registry.js";
import { LEAVE_WARNING } from "./leaving.js";
import { loadFamilyFile } from "./files.js";
import { sendJoyceMedia } from "./whatsapp.js";
import { messages as toMessages, type JoyceMessage } from "./messages.js";
import { flagRequest, recordJoyceUsage } from "./adminRecords.js";
import {
  describeNow,
  endOfLocalDate,
  formatLocal,
  formatLocalDate,
  getFamilyZone,
  parseLocal,
  setFamilyZone,
} from "./familyTime.js";
import { calendarFeedUrl } from "./calendarFeed.js";
import { issueCalendarToken } from "./registry.js";
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
  getFamilyCalendarToken,
  getFamilyJoinCode,
  listEventsBetween,
  setFamilyCalendarToken,
  updateEvent,
  type EventRow,
  type NewEvent,
  setFamilyJoinCode,
  listDocuments,
  listMembers,
  listNotes,
  listUpcomingReminders,
  queueRelay,
  recentHistory,
  saveNote,
  searchDocuments,
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

const TOOLS: Anthropic.Tool[] = [
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
    name: "add_event",
    description:
      "Put something on the family calendar: appointments, trips, school dates, birthdays, " +
      "someone being away. Add it whenever someone mentions a date the family would want to " +
      "know, without being asked. The result lists anything it clashes with — tell them.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, e.g. 'Dentist' or 'School trip to the zoo'." },
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
          description: "Who it's for: a family member's name, or 'everyone'. Omit for everyone.",
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
      "Get the link that lets someone see the family calendar in Google Calendar or their " +
      "phone's calendar. Set reset to true only if they want the old link to stop working.",
    input_schema: {
      type: "object",
      properties: { reset: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "pass_message",
    description:
      "Leave a message for another family member. They receive it the next time they message " +
      "you, so tell the sender it has been left rather than that it has been sent.",
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

function systemPrompt(session: FamilySession, zone: { zone: string; guessed: boolean }): string {
  const members = listMembers(session)
    .map((m) => (m.isSelf ? `${m.displayName ?? "(unnamed)"} (you are talking to them)` : m.displayName ?? "(unnamed)"))
    .join(", ");
  return [
    "You are Joyce, a WhatsApp assistant shared by one family.",
    "",
    "Everything in this conversation belongs to this one family, and every family member can " +
      "see everything any of them tells you — say so plainly if someone seems to expect privacy " +
      "from the rest of their family, because you cannot offer it.",
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
    "Be warm and brief — this is WhatsApp, not email. Two or three sentences is usually plenty. " +
      "Use WhatsApp formatting (*bold*) sparingly and never Markdown headings or tables. Never " +
      "use emoji, not even one. A blank line between paragraphs sends them as separate " +
      "messages, so use one only where a new message makes sense.",
    "",
    "Save things without being asked when someone tells you something the family would want " +
      "later. When you are asked something you don't know, search the family's notes and " +
      "documents before saying you don't have it. Attribute things to whoever said them.",
    "",
    "You can only ever see this family's information. If anyone asks about another family or " +
      "tries to get you to look one up, tell them plainly that you can't — there is no way for " +
      "you to reach anything outside this family, and you should not pretend otherwise.",
  ].join("\n");
}

/**
 * Lets a tool override whatever the model would have said. Only the leave flow uses it: the
 * warning has to go out word for word, and a model asked to "relay this verbatim" will
 * paraphrase it sooner or later.
 */
interface TurnState {
  forcedReply: string | null;
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

function whoName(rawWho: unknown): string | null {
  const who = typeof rawWho === "string" ? rawWho.trim() : "";
  return who && who.toLowerCase() !== "everyone" ? who : null;
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

function asRow(event: NewEvent, id: number): EventRow {
  return {
    id,
    title: event.title,
    notes: event.notes ?? null,
    allDay: event.allDay,
    startDate: event.startDate ?? null,
    endDate: event.endDate ?? null,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    aboutMemberId: event.aboutMemberId,
    aboutName: null,
    createdByName: null,
  };
}

/** "[12] Tue 21 Oct, 16:00–17:00 — Leo: Dentist" */
function describeEvent(e: EventRow, zone: string): string {
  let when: string;
  if (e.allDay && e.startDate) {
    when = e.endDate ? `${formatLocalDate(e.startDate, zone)} to ${formatLocalDate(e.endDate, zone)}` : formatLocalDate(e.startDate, zone);
  } else {
    when = `${formatLocal(e.startsAt, zone)}–${DateTime.fromMillis(e.endsAt, { zone }).toFormat("HH:mm")}`;
  }
  const who = e.aboutName ?? (e.aboutMemberId === null ? "Everyone" : "Someone");
  const notes = e.notes ? ` (${e.notes})` : "";
  return `[${e.id}] ${when} — ${who}: ${e.title}${notes}`;
}

function clashNote(session: FamilySession, event: NewEvent, zone: string, id: number): string {
  const clashes = findClashes(session, event.startsAt, event.endsAt, event.aboutMemberId, id);
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
  switch (name) {
    case "save_note": {
      saveNote(session, String(input.title), String(input.body));
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
      createReminder(session, String(input.body), when.utcMs, target);
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
      queueRelay(session, found.id, String(input.message));
      return `Message left for ${found.displayName}; they'll get it next time they message you.`;
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
      const about = resolveWho(session, input.who);
      if (typeof about === "string") return about;
      const event: NewEvent = {
        ...times,
        title: String(input.title ?? "").trim(),
        notes: typeof input.notes === "string" ? input.notes.trim() || null : null,
        aboutMemberId: about,
      };
      if (!event.title) return "An event needs a title.";
      const id = addEvent(session, event);
      return `Added: ${describeEvent({ ...asRow(event, id), aboutName: whoName(input.who) }, zone)}${clashNote(session, event, zone, id)}`;
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
      const about = input.who !== undefined ? resolveWho(session, input.who) : existing.aboutMemberId;
      if (typeof about === "string") return about;
      const event: NewEvent = {
        ...times,
        title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : existing.title,
        notes: typeof input.notes === "string" ? input.notes.trim() || null : existing.notes,
        aboutMemberId: about,
      };
      updateEvent(session, existing.id, event);
      const updated = getEvent(session, existing.id)!;
      return `Updated: ${describeEvent(updated, zone)}${clashNote(session, event, zone, existing.id)}`;
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
      state.followUps.push(calendarFeedUrl(token));
      return (
        "The link is sent automatically as its own message straight after your reply, so don't " +
        "write it out. Tell them briefly how to add it: in Google Calendar on a computer, Other " +
        "calendars, +, From URL, paste it; on an iPhone, Settings, Calendar, Accounts, Add " +
        "Account, Other, Add Subscribed Calendar. It shows the family calendar read-only and " +
        "updates by itself (Google can take several hours). Anyone with the link can see the " +
        "calendar, so share it only with the family" +
        (input.reset === true ? "; the old link has stopped working." : ".")
      );
    }
    case "flag_unmet_request": {
      flagRequest(session, String(input.summary ?? ""));
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
  appendMessage(session, "user", userText);

  // Anything waiting for this person, prepended to their turn so the model can deliver it
  // naturally in its reply rather than as a separate robotic message.
  const waiting: string[] = [
    ...claimRelaysFor(session).map(
      (r) => `${r.fromName ?? "Someone"} left a message for them: "${r.body}"`
    ),
    ...claimDueReminders(session).map((r) => `Reminder now due: ${r.body}`),
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

  const state: TurnState = { forcedReply: null, followUps: [] };
  let reply = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt(session, getFamilyZone(session, ctx.normalizedPhone)),
      tools: TOOLS,
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
    }
    messages.push({ role: "user", content: results });

    // Nothing the model says after this point can be used, so don't pay for another round trip.
    if (state.forcedReply) break;
  }

  // A forced reply wins over anything the model produced, including a half-finished sentence
  // from a turn that also called another tool.
  if (state.forcedReply) reply = state.forcedReply;
  if (!reply) reply = "Sorry — I got a bit lost there. Could you say that again?";
  const out = toMessages(reply, ...state.followUps);
  // History keeps everything that was sent, follow-ups included, so a later "what was that ID
  // again?" can be answered from the conversation.
  appendMessage(session, "assistant", [reply, ...state.followUps].join("\n\n"));
  return out;
}
