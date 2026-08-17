import Anthropic from "@anthropic-ai/sdk";
import {
  listAccounts,
  getSetting,
  listRecentMemoryNotes,
  addMemoryNote,
  searchDocuments,
  listDocuments,
  listCheckins,
  listAllCheckinsAscending,
  getEnabledTools,
  TOOL_KEYS,
  type ToolKey,
  type DocumentRow,
} from "../db/store.js";
import { listLocalFolders } from "../providers/local.js";
import { fetchHeadlines, NEWS_TOPICS, type NewsTopic } from "../providers/news.js";
import { fetchWeather } from "../providers/weather.js";
import { fetchQuotes, DEFAULT_SYMBOLS } from "../providers/markets.js";
import { countTravelDays } from "../services/travelDays.js";
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

const ALWAYS_ON_TOOLS: Anthropic.Tool[] = [
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
    name: "get_news",
    description:
      "Fetch current news headlines from free public RSS feeds. Call this when the user asks what's happening in the news, for a news summary, or about current events in a specific area (e.g. 'any tech news today'). This is a direct, on-demand fetch — it works regardless of whether the user has news turned on for their morning briefing, since asking here is an explicit request.",
    input_schema: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string", enum: Object.keys(NEWS_TOPICS) },
          description: `One or more of: ${Object.keys(NEWS_TOPICS).join(", ")}. Omit to fetch all topics.`,
        },
      },
    },
  },
  {
    name: "get_weather",
    description:
      "Look up the current weather and today's high/low for a place. Call this whenever the user asks about weather anywhere — it accepts any city or place name, not just the one saved in their briefing settings.",
    input_schema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "A city or place name, e.g. 'Lisbon' or 'Austin, Texas'.",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "get_markets",
    description:
      "Fetch current prices and daily change for stock tickers or market indices. Call this for questions about how a stock or the market is doing. Use standard ticker symbols (AAPL, MSFT) and caret-prefixed symbols for indices (^GSPC for S&P 500, ^IXIC for Nasdaq, ^FTSE for FTSE 100). Omit symbols to get the major indices.",
    input_schema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Ticker symbols to look up. Omit for the major indices.",
        },
      },
    },
  },
];

const CONDITIONAL_TOOLS: Record<ToolKey, Anthropic.Tool[]> = {
  teams: [
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
  ],
  travel: [
    {
      name: "list_travel_checkins",
      description:
        "List the user's location check-ins (country/city + timestamp), newest first. These are logged automatically by a phone automation when the user lands somewhere or crosses a border — not something they send manually. Call this for travel questions like 'where have I been' or 'when did I arrive in France'. This is raw location history, not day-counting — use count_travel_days for duration questions instead of doing the arithmetic yourself.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max check-ins, default 50" },
        },
      },
    },
    {
      name: "count_travel_days",
      description:
        "Count how many days the user has spent in a country or region, computed deterministically from logged location check-ins (not documents/boarding passes). Use area 'schengen' or 'eu' for those groupings, or the exact country name as it appears in list_travel_checkins output (case-insensitive) — check that tool first if unsure of the exact spelling. Defaults to the last 180 days (the window relevant to the Schengen 90/180 rule) if no dates are given; pass explicit since_date/until_date (YYYY-MM-DD) for a different range, e.g. a specific year.",
      input_schema: {
        type: "object",
        properties: {
          area: { type: "string", description: "'schengen', 'eu', or an exact country name" },
          since_date: { type: "string", description: "ISO date YYYY-MM-DD, default 180 days ago" },
          until_date: { type: "string", description: "ISO date YYYY-MM-DD, default today" },
        },
        required: ["area"],
      },
    },
  ],
};

export function buildToolsForOwner(ownerId: number): Anthropic.Tool[] {
  const enabled = getEnabledTools(ownerId);
  const result = [...ALWAYS_ON_TOOLS];
  for (const key of TOOL_KEYS) {
    if (enabled.has(key)) result.push(...CONDITIONAL_TOOLS[key]);
  }
  // Cache breakpoint must be on the LAST tool schema in the array — which tool that is now
  // depends on which conditional tools are enabled, so it's set dynamically here rather than
  // hardcoded on one specific tool definition like before.
  if (result.length > 0) {
    result[result.length - 1] = {
      ...result[result.length - 1],
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
  }
  return result;
}

function forModel(doc: DocumentRow) {
  const { storedPath: _storedPath, ...rest } = doc;
  return rest;
}

const TOOL_NAME_TO_KEY: Record<string, ToolKey> = {
  list_recent_chats: "teams",
  search_chats: "teams",
  list_travel_checkins: "travel",
  count_travel_days: "travel",
};

export async function runTool(ownerId: number, name: string, input: Record<string, unknown>): Promise<unknown> {
  const requiredKey = TOOL_NAME_TO_KEY[name];
  if (requiredKey && !getEnabledTools(ownerId).has(requiredKey)) {
    return { error: `tool not enabled: ${name}` };
  }
  switch (name) {
    case "list_recent_messages":
      return hubListMessages(ownerId, {
        accountId: input.account_id as number | undefined,
        limit: (input.limit as number | undefined) ?? 10,
      });
    case "search_messages":
      return hubListMessages(ownerId, {
        query: input.query as string,
        accountId: input.account_id as number | undefined,
        limit: (input.limit as number | undefined) ?? 10,
      });
    case "get_message":
      return hubGetMessage(ownerId, input.account_id as number, input.message_id as string);
    case "list_upcoming_events":
      return hubListEvents(ownerId, (input.days as number | undefined) ?? 7);
    case "search_files":
      return hubSearchFiles(ownerId, input.query as string);
    case "list_recent_chats":
      return hubListChats(ownerId, (input.limit as number | undefined) ?? 20);
    case "search_chats":
      return hubSearchChats(ownerId, input.query as string);
    case "create_email_draft":
      return hubCreateDraft(
        ownerId,
        input.account_id as number,
        input.to as string,
        input.subject as string,
        input.body as string
      );
    case "search_contacts":
      return hubSearchContacts(ownerId, input.query as string);
    case "create_calendar_event":
      return hubCreateEvent(ownerId, input.account_id as number, {
        title: input.title as string,
        start: input.start as string,
        end: input.end as string,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
      });
    case "update_calendar_event":
      return hubUpdateEvent(ownerId, input.account_id as number, input.event_id as string, {
        title: input.title as string | undefined,
        start: input.start as string | undefined,
        end: input.end as string | undefined,
        location: input.location as string | undefined,
        description: input.description as string | undefined,
      });
    case "delete_calendar_event":
      await hubDeleteEvent(ownerId, input.account_id as number, input.event_id as string);
      return { ok: true };
    case "archive_messages":
      return {
        archived: await hubArchiveMessages(
          ownerId,
          input.account_id as number,
          input.query as string,
          (input.limit as number | undefined) ?? 50
        ),
      };
    case "label_message":
      await hubAddLabel(ownerId, input.account_id as number, input.message_id as string, input.label as string);
      return { ok: true };
    case "remember":
      addMemoryNote(ownerId, input.note as string);
      return { ok: true };
    case "list_needs_attention":
      return hubFlaggedMessages(ownerId);
    case "search_documents":
      return searchDocuments(ownerId, input.query as string).map(forModel);
    case "list_recent_documents":
      return listDocuments(ownerId, (input.limit as number | undefined) ?? 10).map(forModel);
    case "get_news": {
      const requested = (input.topics as string[] | undefined)?.filter((t): t is NewsTopic =>
        Object.prototype.hasOwnProperty.call(NEWS_TOPICS, t)
      );
      const topics = requested?.length ? requested : (Object.keys(NEWS_TOPICS) as NewsTopic[]);
      return fetchHeadlines(topics, 6);
    }
    case "get_weather": {
      const report = await fetchWeather(input.location as string);
      return report ?? { error: `couldn't find a place called "${input.location as string}"` };
    }
    case "get_markets": {
      const requested = (input.symbols as string[] | undefined) ?? [];
      const quotes = await fetchQuotes(requested.length ? requested : DEFAULT_SYMBOLS);
      return quotes.length ? quotes : { error: "no quotes could be fetched for those symbols" };
    }
    case "list_travel_checkins":
      return listCheckins(ownerId, (input.limit as number | undefined) ?? 50);
    case "count_travel_days": {
      const now = Date.now();
      const untilMs = input.until_date ? new Date(input.until_date as string).getTime() : now;
      const sinceMs = input.since_date
        ? new Date(input.since_date as string).getTime()
        : untilMs - 180 * 24 * 60 * 60 * 1000;
      return countTravelDays(listAllCheckinsAscending(ownerId), input.area as string, sinceMs, untilMs);
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function buildRules(enabled: Set<ToolKey>): string {
  const base = [
    "- Always look up real data with your tools before answering questions about email, calendar, or files — never invent contents.",
    "- You can create email drafts but can never send email. After creating a draft, tell the user to review and send it from their mailbox.",
    "- You can create, edit, and delete calendar events directly on the user's own calendar — these are low-risk and reversible. You can never invite other people to an event; calendar events you create are personal-only.",
    '- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don\'t need to ask permission first, but do confirm if the query is broad or ambiguous (e.g. "archive everything" with no filter).',
    "- Use search_contacts to resolve a name to an email address before drafting to someone when you don't already have their address.",
    "- Use the remember tool proactively whenever the user shares something worth recalling later (preferences, which account is which, standing instructions) — don't wait to be asked.",
    '- Use search_documents/list_recent_documents when the user asks about something they photographed or sent via WhatsApp (boarding passes, licenses, tickets, receipts) — e.g. "when did I fly to X" or "what\'s the code on my license".',
    "- Use get_news for news/current-events questions. Only report headlines the tool actually returned — never supplement with your own general knowledge or training data, even for well-known ongoing events. Fabricating a headline is a serious error, same as with any other tool's data.",
    "- Use get_weather and get_markets for weather and stock/index questions. The same rule applies: report only what the tool returned. Never state a price, a percentage move, or a forecast you didn't just fetch.",
  ];
  const travel = [
    "- Use list_travel_checkins for questions about where the user has physically been or when they arrived somewhere — this is automatic location history, separate from documents.",
    '- Use count_travel_days for "how many days have I spent in X" style questions — never estimate day counts yourself from raw check-in timestamps or document text.',
  ];
  const tail = [
    '- When a message reports a document that was just saved (e.g. a WhatsApp photo/PDF), don\'t dump every extracted field back at the user — give a short confirmation of only the key fact(s) (e.g. what it is, and the one or two details most likely to matter, like dates or a confirmation code), then carry out whatever else was asked. Save the full itemized breakdown for if the user explicitly asks to see all the details (e.g. "show me everything on it").',
    '- When one message asks for multiple things (e.g. "save this and also add it to my calendar"), do all of them in that same turn using your tools — don\'t complete only the first one and wait to be asked again for the rest.',
    "- When several accounts are connected and the user's request is ambiguous about which one, search across all of them or ask.",
    "- Keep answers concise and lead with the direct answer.",
  ];
  return ["Rules:", ...base, ...(enabled.has("travel") ? travel : []), ...tail].join("\n");
}

export function buildSystemPrompt(ownerId: number): string {
  const accounts = listAccounts(ownerId);
  const persona = getSetting(ownerId, "persona");
  const name = getSetting(ownerId, "assistant_name") ?? "Assistant";

  const accountList = accounts.length
    ? accounts.map((a) => `- id ${a.id}: ${a.email} (${a.provider})`).join("\n")
    : "(none connected — tell the user to connect an account on the Setup page first)";

  const folders = listLocalFolders(ownerId);
  const folderList = folders.length
    ? folders.map((f) => `- ${f.path}`).join("\n")
    : "(none configured)";

  const memories = listRecentMemoryNotes(ownerId).reverse();
  const memoryList = memories.length
    ? memories.map((m) => `- ${m.content}`).join("\n")
    : "(nothing remembered yet)";

  return [
    `You are ${name}, a personal assistant that manages the user's connected accounts. Today's date is ${new Date().toDateString()}.`,
    persona ? `The user described how they want you to behave:\n${persona}` : "",
    `Connected accounts:\n${accountList}`,
    `Local computer folders searchable by file name:\n${folderList}`,
    `Things you've learned about the user over past conversations:\n${memoryList}`,
    buildRules(getEnabledTools(ownerId)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runAssistantChat(ownerId: number, history: ChatMessage[]): Promise<string> {
  const anthropic = getClient();
  const system = buildSystemPrompt(ownerId);

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
      tools: buildToolsForOwner(ownerId),
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
          const result = await runTool(ownerId, toolUse.name, toolUse.input as Record<string, unknown>);
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
