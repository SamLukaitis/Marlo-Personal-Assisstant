import Anthropic from "@anthropic-ai/sdk";
import type { FamilySession } from "./familyDb.js";
import { requestLeave, rotateJoinCode } from "./registry.js";
import { LEAVE_WARNING } from "./leaving.js";
import { loadFamilyFile } from "./files.js";
import { sendJoyceMedia } from "./whatsapp.js";
import { messages as toMessages, type JoyceMessage } from "./messages.js";
import {
  appendMessage,
  claimDueReminders,
  claimRelaysFor,
  createReminder,
  findMemberByName,
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
      "Set a reminder. It is delivered the next time the person messages you after it comes " +
      "due, so say so rather than promising it will arrive at that exact moment.",
    input_schema: {
      type: "object",
      properties: {
        body: { type: "string", description: "What to remind them about." },
        due_at: {
          type: "string",
          description: "When it is due, as a full ISO-8601 UTC timestamp, e.g. 2026-10-02T09:00:00Z.",
        },
        who: {
          type: "string",
          description:
            "The family member's name, or 'everyone' for the whole family. Omit for everyone.",
        },
      },
      required: ["body", "due_at"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reminders",
    description: "List the family's upcoming reminders that haven't been delivered yet.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
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

function systemPrompt(session: FamilySession): string {
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
    `The current time is ${new Date().toISOString()} (UTC). All reminder times are UTC.`,
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
      const dueAt = Date.parse(String(input.due_at));
      if (Number.isNaN(dueAt)) {
        return "That due date wasn't a valid ISO-8601 timestamp. Ask the user to clarify when they mean.";
      }
      const who = typeof input.who === "string" ? input.who.trim() : "";
      let targetId: number | null = null;
      if (who && who.toLowerCase() !== "everyone") {
        const found = findMemberByName(session, who);
        if (!found.found) {
          return found.reason === "ambiguous"
            ? `More than one family member is called "${who}" — ask which one they mean.`
            : `Nobody in this family is called "${who}". Check who_is_in_the_family and ask.`;
        }
        targetId = found.id;
      }
      createReminder(session, String(input.body), dueAt, targetId);
      return targetId === null ? "Reminder set for the whole family." : `Reminder set for ${who}.`;
    }
    case "list_reminders": {
      const rows = listUpcomingReminders(session);
      if (rows.length === 0) return "No reminders pending.";
      return rows
        .map(
          (r) =>
            `${r.body} — for ${r.targetName ?? "everyone"}, due ${new Date(r.dueAt).toISOString()}, ` +
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
    case "new_family_id": {
      // rotateJoinCode picks the family from the caller's own phone, not from any argument, so
      // there is no way to rotate another family's code. It addresses the registry rather than
      // the family database, which is why this is the one tool needing the phone number.
      const code = rotateJoinCode(ctx.normalizedPhone);
      if (!code) return "Couldn't issue a new family ID.";
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
      system: systemPrompt(session),
      tools: TOOLS,
      messages,
    });

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
