import Anthropic from "@anthropic-ai/sdk";
import {
  listAccounts,
  getSetting,
  listRecentMemoryNotes,
  addMemoryNote,
  searchDocuments,
  listDocuments,
  listCheckins,
  type DocumentRow,
} from "../db/store.js";
import { listLocalFolders } from "../providers/local.js";
import {
  hubListMessages,
  hubGetMessage,
  hubListEvents,
  hubSearchFiles,
  hubCreateDraft,
  hubListChats,
  hubSearchChats,
  hubCreateEvent,
  hubUpdateEvent,
  hubDeleteEvent,
  hubArchiveMessages,
  hubAddLabel,
  hubSearchContacts,
  hubFlaggedMessages,
} from "../services/hub.js";

// Cheap tier for lookups/summaries, richer tier for anything needing judgment or drafting.
// No classifier call to pick between them — that would add an extra API round-trip for a
// decision that keyword matching on the latest message handles for free.
const MODEL_SIMPLE = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";
const MODEL_COMPLEX = process.env.ASSISTANT_MODEL_COMPLEX ?? "claude-sonnet-5";

const COMPLEX_PATTERNS = [
  /\bdraft\b/i, /\bwrite\b/i, /\bcompose\b/i, /\breply to\b/i, /\brespond to\b/i,
  /\bplan\b/i, /\banaly[sz]e\b/i, /\bcompare\b/i, /\bshould i\b/i, /\bwhy\b/i,
  /\bdecide\b/i, /\bstrategy\b/i, /\bnegotiate\b/i, /\bin depth\b/i, /\bdetailed\b/i,
  /\brecommend\b/i, /\bthink about\b/i, /\bhow many days\b/i,
];
const SIMPLE_PATTERNS = [
  /\bsummari[sz]e\b/i, /\bwhat'?s (new|on|unread|upcoming)\b/i, /\bany new\b/i,
  /\blist\b/i, /\bshow me\b/i, /\bwhat (is|are)\b/i, /\bcheck\b/i, /\bfind\b/i,
  /\bsearch\b/i, /\bwhen is\b/i, /\bunread\b/i, /\btoday'?s\b/i, /\barchive\b/i,
];

function chooseModel(latestUserMessage: string): string {
  if (COMPLEX_PATTERNS.some((p) => p.test(latestUserMessage))) return MODEL_COMPLEX;
  if (SIMPLE_PATTERNS.some((p) => p.test(latestUserMessage))) return MODEL_SIMPLE;
  return MODEL_COMPLEX; // unmatched phrasing defaults to the safer tier, not the cheapest
}

// How many prior turns get resent as raw history. Older turns are neither summarized nor kept
// — durable facts are expected to live in memory notes (via the `remember` tool) instead, so
// this just bounds per-call token cost rather than trying to preserve everything forever.
export const MAX_HISTORY_MESSAGES = 12;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set — add it to server/.env");
    }
    client = new Anthropic();
  }
  return client;
}

const tools: Anthropic.Tool[] = [
  {
    name: "list_recent_messages",
    description:
      "List the most recent emails across all connected accounts (or one account). Call this when the user asks what's new, what's unread, or about recent mail.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "Restrict to one connected account" },
        limit: { type: "number", description: "Max messages, default 10" },
      },
    },
  },
  {
    name: "search_messages",
    description:
      "Search emails across connected accounts with a query (sender, subject keywords, Gmail search operators like from: or has:attachment). Call this whenever the user asks to find a specific email or topic.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        account_id: { type: "number" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_message",
    description:
      "Fetch the full body of one email. Call this after list/search when the user needs details, a summary of the content, or before drafting a reply.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        message_id: { type: "string" },
      },
      required: ["account_id", "message_id"],
    },
  },
  {
    name: "list_upcoming_events",
    description:
      "List calendar events for the coming days across all connected accounts. Call this when the user asks about their schedule, meetings, or availability.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead, default 7" },
      },
    },
  },
  {
    name: "search_files",
    description:
      "Search files by name across the user's connected Google Drive, OneDrive, and configured local computer folders. Call this when the user asks to find a document, invoice, spreadsheet, photo, or other file.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent_chats",
    description:
      "List the user's most recent Microsoft Teams conversations (direct messages and group chats). Call this when the user asks what's new in Teams or about recent chat messages.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max chats, default 20" },
      },
    },
  },
  {
    name: "search_chats",
    description:
      "Search the user's Microsoft Teams chat messages by keyword. Call this when the user asks to find something someone said in Teams.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_email_draft",
    description:
      "Create an email DRAFT in the user's mailbox (Gmail or Outlook). The draft is never sent automatically — the user reviews and sends it themselves. Call this when the user asks you to write, draft, or reply to an email. Confirm recipient and content in conversation first if ambiguous.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "Which connected account to draft from" },
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text email body" },
      },
      required: ["account_id", "to", "subject", "body"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Look up a person's email address by name across the user's connected accounts. Call this before drafting an email or creating an event with attendees when you only have a name (e.g. 'Sarah'), not an address.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or partial name to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a new event on the user's own calendar. This never invites other people — it only ever creates a personal event on the specified account's calendar. Times must be ISO 8601 datetimes (e.g. 2026-07-23T14:00:00Z).",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "Which connected account's calendar" },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start datetime" },
        end: { type: "string", description: "ISO 8601 end datetime" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["account_id", "title", "start", "end"],
    },
  },
  {
    name: "update_calendar_event",
    description:
      "Reschedule or edit an existing calendar event. Get the event_id from list_upcoming_events first. Only pass the fields that should change.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        event_id: { type: "string" },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 start datetime" },
        end: { type: "string", description: "ISO 8601 end datetime" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["account_id", "event_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description:
      "Delete/cancel a calendar event. Get the event_id from list_upcoming_events first. Confirm with the user before deleting unless they were explicit about which event.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        event_id: { type: "string" },
      },
      required: ["account_id", "event_id"],
    },
  },
  {
    name: "archive_messages",
    description:
      "Archive emails matching a search query (removes them from the inbox but keeps them, fully reversible). Call this when the user asks to archive, clean up, or clear out emails matching a description, e.g. 'archive everything from Nike'.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        query: { type: "string", description: "Search query identifying which messages to archive" },
        limit: { type: "number", description: "Max messages to archive, default 50" },
      },
      required: ["account_id", "query"],
    },
  },
  {
    name: "label_message",
    description:
      "Apply a label (Gmail) or category (Outlook) to a message. Creates the label if it doesn't exist yet.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        message_id: { type: "string" },
        label: { type: "string" },
      },
      required: ["account_id", "message_id", "label"],
    },
  },
  {
    name: "remember",
    description:
      "Save a fact or preference about the user for future conversations — e.g. which account belongs to which business, a standing instruction, or context they've shared. Call this whenever the user tells you something worth recalling later, without waiting to be asked. Keep it to one clear sentence.",
    input_schema: {
      type: "object",
      properties: {
        note: { type: "string", description: "One clear sentence to remember" },
      },
      required: ["note"],
    },
  },
  {
    name: "list_needs_attention",
    description:
      "List emails that look like they've been sitting unread for a while from real people (not newsletters/notifications). Call this when the user asks what needs attention, what they're missing, or what's falling through the cracks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_documents",
    description:
      "Search photos/documents the user has sent via WhatsApp (boarding passes, licenses, tickets, receipts, IDs, etc.) by keyword. Searches filenames, captions, and the extracted text/details from each file. Call this when the user asks about something they photographed or sent you, e.g. 'when did I fly to Berlin' or 'what's the code on my license'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent_documents",
    description:
      "List the most recently saved photos/documents the user has sent via WhatsApp, newest first. Call this when the user asks what's been saved or wants a general overview rather than searching for something specific.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max documents, default 10" },
      },
    },
  },
  {
    name: "list_travel_checkins",
    description:
      "List the user's location check-ins (country/city + timestamp), newest first. These are logged automatically by a phone automation when the user lands somewhere or crosses a border — not something they send manually. Call this for travel questions like 'where have I been' or 'when did I arrive in France'. This is raw location history, not day-counting — do the arithmetic yourself from the timestamps if asked to compute durations.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max check-ins, default 50" },
      },
    },
    // Cache breakpoint: these 18 tool schemas are identical on every call (web or WhatsApp),
    // so this is close to free — Anthropic caches everything up to and including this block.
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
];

function forModel(doc: DocumentRow) {
  const { storedPath: _storedPath, ...rest } = doc;
  return rest;
}

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "list_recent_messages":
      return hubListMessages({
        accountId: input.account_id as number | undefined,
        limit: (input.limit as number | undefined) ?? 10,
      });
    case "search_messages":
      return hubListMessages({
        query: input.query as string,
        accountId: input.account_id as number | undefined,
        limit: (input.limit as number | undefined) ?? 10,
      });
    case "get_message":
      return hubGetMessage(input.account_id as number, input.message_id as string);
    case "list_upcoming_events":
      return hubListEvents((input.days as number | undefined) ?? 7);
    case "search_files":
      return hubSearchFiles(input.query as string);
    case "list_recent_chats":
      return hubListChats((input.limit as number | undefined) ?? 20);
    case "search_chats":
      return hubSearchChats(input.query as string);
    case "create_email_draft":
      return hubCreateDraft(
        input.account_id as number,
        input.to as string,
        input.subject as string,
        input.body as string
      );
    case "search_contacts":
      return hubSearchContacts(input.query as string);
    case "create_calendar_event":
      return hubCreateEvent(input.account_id as number, {
        title: input.title as string,
        start: input.start as string,
        end: input.end as string,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
      });
    case "update_calendar_event":
      return hubUpdateEvent(input.account_id as number, input.event_id as string, {
        title: input.title as string | undefined,
        start: input.start as string | undefined,
        end: input.end as string | undefined,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
      });
    case "delete_calendar_event":
      await hubDeleteEvent(input.account_id as number, input.event_id as string);
      return { ok: true };
    case "archive_messages":
      return {
        archived: await hubArchiveMessages(
          input.account_id as number,
          input.query as string,
          (input.limit as number | undefined) ?? 50
        ),
      };
    case "label_message":
      await hubAddLabel(input.account_id as number, input.message_id as string, input.label as string);
      return { ok: true };
    case "remember":
      addMemoryNote(input.note as string);
      return { ok: true };
    case "list_needs_attention":
      return hubFlaggedMessages();
    case "search_documents":
      return searchDocuments(input.query as string).map(forModel);
    case "list_recent_documents":
      return listDocuments((input.limit as number | undefined) ?? 10).map(forModel);
    case "list_travel_checkins":
      return listCheckins((input.limit as number | undefined) ?? 50);
    default:
      return { error: `unknown tool: ${name}` };
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function buildSystemPrompt(): string {
  const accounts = listAccounts();
  const persona = getSetting("persona");
  const name = getSetting("assistant_name") ?? "Assistant";

  const accountList = accounts.length
    ? accounts.map((a) => `- id ${a.id}: ${a.email} (${a.provider})`).join("\n")
    : "(none connected — tell the user to connect an account on the Setup page first)";

  const folders = listLocalFolders();
  const folderList = folders.length
    ? folders.map((f) => `- ${f.path}`).join("\n")
    : "(none configured)";

  const memories = listRecentMemoryNotes().reverse();
  const memoryList = memories.length
    ? memories.map((m) => `- ${m.content}`).join("\n")
    : "(nothing remembered yet)";

  return [
    `You are ${name}, a personal assistant that manages the user's connected accounts. Today's date is ${new Date().toDateString()}.`,
    persona ? `The user described how they want you to behave:\n${persona}` : "",
    `Connected accounts:\n${accountList}`,
    `Local computer folders searchable by file name:\n${folderList}`,
    `Things you've learned about the user over past conversations:\n${memoryList}`,
    `Rules:
- Always look up real data with your tools before answering questions about email, calendar, or files — never invent contents.
- You can create email drafts but can never send email. After creating a draft, tell the user to review and send it from their mailbox.
- You can create, edit, and delete calendar events directly on the user's own calendar — these are low-risk and reversible. You can never invite other people to an event; calendar events you create are personal-only.
- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don't need to ask permission first, but do confirm if the query is broad or ambiguous (e.g. "archive everything" with no filter).
- Use search_contacts to resolve a name to an email address before drafting to someone when you don't already have their address.
- Use the remember tool proactively whenever the user shares something worth recalling later (preferences, which account is which, standing instructions) — don't wait to be asked.
- Use search_documents/list_recent_documents when the user asks about something they photographed or sent via WhatsApp (boarding passes, licenses, tickets, receipts) — e.g. "when did I fly to X" or "what's the code on my license".
- Use list_travel_checkins for questions about where the user has physically been or when they arrived somewhere — this is automatic location history, separate from documents.
- When several accounts are connected and the user's request is ambiguous about which one, search across all of them or ask.
- Keep answers concise and lead with the direct answer.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runAssistantChat(history: ChatMessage[]): Promise<string> {
  const anthropic = getClient();
  const system = buildSystemPrompt();

  // Bound history defensively here (not just at the WhatsApp DB-read site) so the web chat
  // route — which resends whatever the client has accumulated — gets the same cap.
  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);
  const lastUserMessage =
    [...trimmedHistory].reverse().find((m) => m.role === "user")?.content ?? "";
  const model = chooseModel(lastUserMessage);
  const useThinking = model !== MODEL_SIMPLE; // skip extended thinking for cheap lookup turns

  const messages: Anthropic.MessageParam[] = trimmedHistory.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let turn = 0; turn < 8; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      ...(useThinking ? { thinking: { type: "adaptive" as const } } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools,
      messages,
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      const text = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      return text?.text ?? "";
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        try {
          const result = await runTool(toolUse.name, toolUse.input as Record<string, unknown>);
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: `Error: ${(err as Error).message}`,
            is_error: true,
          };
        }
      })
    );

    messages.push({ role: "user", content: toolResults });
  }

  return "I wasn't able to finish that within my tool-call limit — try a more specific request.";
}
