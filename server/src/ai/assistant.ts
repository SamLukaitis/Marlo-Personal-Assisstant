import Anthropic from "@anthropic-ai/sdk";
import {
  listAccounts,
  getSetting,
  listRecentMemoryNotes,
  addMemoryNote,
  searchMemoryNotes,
  searchWhatsAppHistory,
  searchDocuments,
  listDocuments,
  listCheckins,
  listAllCheckinsAscending,
  listEntities,
  getEntity,
  saveEntity,
  linkRecords,
  getLinksTo,
  getRelatedEntities,
  findOrCreateEntity,
  appendEntityNote,
  findEntityByName,
  getDocument,
  getEnabledTools,
  setToolEnabled,
  TOOL_KEYS,
  createPendingAction,
  getConversationSummary,
  getPendingSetup,
  addUnmetRequest,
  recordApiUsage,
  type ToolKey,
  type DocumentRow,
} from "../db/store.js";
import { validateTrip, type ExpenseData, type BookingData, type TripData } from "../services/entityValidation.js";
import { listLocalFolders } from "../providers/local.js";
import { fetchHeadlines, NEWS_TOPICS, type NewsTopic } from "../providers/news.js";
import { fetchWeather } from "../providers/weather.js";
import { fetchQuotes, DEFAULT_SYMBOLS } from "../providers/markets.js";
import { countTravelDays } from "../services/travelDays.js";
import { findFreeSlots } from "../services/freeSlots.js";
import { buildSpendingDigest } from "../services/spendingDigest.js";
import { getBriefingSettings, saveBriefingSettings } from "../services/briefing.js";
import { getXeroForwardingEmail, setXeroForwardingEmail } from "../services/xero.js";
import {
  getPendingInvoiceForward,
  clearPendingInvoiceForward,
} from "../services/xeroInvoiceConfirmation.js";
import { ingestEmailAttachment, ingestEmailBodyReceipt, sendSavedDocumentFile } from "../services/documents.js";
import {
  hubListMessages,
  hubGetMessage,
  hubListEvents,
  hubSearchFiles,
  hubCreateDraft,
  hubSendMessage,
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
import type { UnifiedMessage } from "../providers/types.js";

// Cheap tier for lookups/summaries, richer tier for anything needing judgment or drafting.
// No classifier call to pick between them — that would add an extra API round-trip for a
// decision that keyword matching on the latest message handles for free.
export const MODEL_SIMPLE = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";
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

// How many prior turns get resent as raw history. Anything older than this is no longer sent
// verbatim, but for WhatsApp conversations it isn't lost either — see
// services/conversationSummary.ts, which rolls it into a compact running summary injected into
// the system prompt instead (buildSystemPrompt's conversationSummary param). Durable standing
// facts (preferences, which account is which) still belong in memory notes via the `remember`
// tool regardless — the rolling summary is conversational continuity, not a replacement for that.
export const MAX_HISTORY_MESSAGES = 24;

// search_messages is a targeted query, not a recent-inbox dump — 10 was too shallow (a single
// broad topic search routinely needs to scan past newsletters/automated mail to find the actual
// confirmation email). list_recent_messages is also raised, from 10 to 20 — still deliberately
// narrower than search's 30 since an unfiltered "what's new" ask has less reason to go deep. See
// docs/superpowers/specs/2026-08-26-email-search-depth-and-attachment-extraction-design.md.
export const SEARCH_MESSAGES_DEFAULT_LIMIT = 30;
export const LIST_RECENT_MESSAGES_DEFAULT_LIMIT = 20;
export const SEARCH_MEMORY_DEFAULT_LIMIT = 10;
export const SEARCH_CONVERSATION_HISTORY_DEFAULT_LIMIT = 20;

// Tools whose effect can't be undone once run. The model may reach these only via a user-confirmed
// ask_user_choice(mode="confirm") pending action (see buildChoiceReply below and actionHandlers.ts,
// which is the only other caller of runTool for one of these) — never by calling them directly in
// a live turn. Enforced in the loop below rather than left to the tool's own description text, so
// it holds even if the model skips that instruction under an unusual conversational branch or
// prompt injection from message content it's reading. Extend this set as more irreversible-action
// tools are added; a tool not in it behaves exactly as before (reversible actions don't need this).
const CONFIRM_REQUIRED_TOOLS = new Set<string>(["delete_calendar_event", "send_email"]);

let client: Anthropic | null = null;
// Exported so portalRoutes.ts's log-explain endpoint can reuse the same lazily-created client
// instead of standing up a second one.
export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set — add it to server/.env");
    }
    client = new Anthropic();
  }
  return client;
}

const ALWAYS_ON_TOOLS: Anthropic.ToolUnion[] = [
  {
    name: "list_recent_messages",
    description:
      "List the most recent emails across all connected accounts (or one account). Call this when the user asks what's new, what's unread, or about recent mail.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "Restrict to one connected account" },
        limit: { type: "number", description: "Max messages, default 20" },
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
        limit: { type: "number", description: "Max messages, default 30" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_message",
    description:
      "Fetch the full body of one email, including metadata (filename, size) for any attachments — see the `attachments` field on the result. Call this after list/search when the user needs details, a summary of the content, or before drafting a reply. If the user is asking about a booking/ticket/receipt and the email has an attachment, use extract_email_attachment on it rather than only reading the body text.",
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
    name: "find_free_time",
    description:
      "Find open gaps in the user's calendar across all connected accounts, within a working-hours window each day. Call this when the user asks to find time for something, e.g. 'find me an hour this week' or 'when am I free tomorrow'. Slots are computed deterministically from the actual calendar, not guessed.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to search, default 7" },
        duration_minutes: { type: "number", description: "Minimum length of a usable gap, in minutes, default 30" },
        earliest_hour: { type: "number", description: "Start of the working-hours window, 24h, default 9" },
        latest_hour: { type: "number", description: "End of the working-hours window, 24h, default 18" },
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
    name: "list_expenses",
    description:
      "List expenses automatically extracted from receipts and invoices the user sent in (vendor, amount in minor units like pence/cents, currency, date), newest first. Call this for questions like 'what have I spent' or 'find that taxi receipt'. Amounts were validated deterministically at extraction time; a status of needs_review means the extraction had a flagged doubt.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max expenses, default 50" },
      },
    },
  },
  {
    name: "list_bookings",
    description:
      "List flight and hotel bookings automatically extracted from confirmations the user sent in (kind: flight|hotel, name, reference code, dates), newest first. Call this for questions like 'when is my flight' or 'what hotel did I book'. A status of needs_review means the extraction had a flagged doubt.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max bookings, default 50" },
        kind: { type: "string", enum: ["flight", "hotel"], description: "Only this kind" },
      },
    },
  },
  {
    name: "get_spending_digest",
    description:
      "Summarize spending and bookings over a period: totals per currency, top vendors, the change vs the prior period of equal length, and how many upcoming bookings fall in range. Call this for questions like 'how much have I spent this month' or 'what's my spending trend'. Amounts flagged needs_review are excluded from totals and reported as a separate count so a low-confidence extraction can't silently skew the numbers.",
    input_schema: {
      type: "object",
      properties: {
        since_date: { type: "string", description: "YYYY-MM-DD, default 30 days ago" },
        until_date: { type: "string", description: "YYYY-MM-DD, default today" },
      },
    },
  },
  {
    name: "create_trip",
    description:
      "Create a trip — a grouping for everything belonging to one journey (bookings, expenses, check-ins, documents). Call this when the user wants to start tracking a trip by place and dates, then use link_to_trip to attach things to it.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Human-readable label, e.g. 'Lisbon, 12-15 Jun 2026'" },
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD; omit if the trip is still open/ongoing" },
      },
      required: ["label", "start_date"],
    },
  },
  {
    name: "link_to_trip",
    description:
      "Attach an existing expense, booking, travel check-in, or document to a trip, so get_trip_contents can pull everything for that journey together in one call. Call this after create_trip, or when the user says something like 'that hotel booking was for the Lisbon trip'.",
    input_schema: {
      type: "object",
      properties: {
        trip_id: { type: "number", description: "The trip's id, from create_trip or get_trip_contents" },
        entity_id: {
          type: "number",
          description: "id of an expense/booking/travel_checkin entity to attach (ids come from list_expenses/list_bookings/list_travel_checkins)",
        },
        document_id: {
          type: "number",
          description: "id of a document to attach directly, when there's no derived entity for it",
        },
      },
      required: ["trip_id"],
    },
  },
  {
    name: "get_trip_contents",
    description:
      "Get everything linked to a trip — bookings, expenses, check-ins, and documents — in one call. Call this when the user asks about a specific trip, e.g. 'what do we have for the Lisbon trip'.",
    input_schema: {
      type: "object",
      properties: {
        trip_id: { type: "number" },
      },
      required: ["trip_id"],
    },
  },
  {
    name: "create_email_draft",
    description:
      "Save an email as a DRAFT in the user's mailbox (Gmail or Outlook) without sending it. Call this yourself, with no confirmation needed, only when the user explicitly asks to leave something in drafts rather than send it. For a normal 'write/draft/reply to an email' request, write the content and use ask_user_choice as described in the send_email rule instead — don't call create_email_draft first.",
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
    name: "send_email",
    description:
      "Send an email from the user's own mailbox. This is irreversible — you can only reach it through a user-confirmed ask_user_choice(mode=\"confirm\") pending action (see the rules), never by calling it directly. Gmail accounts only for now; Outlook accounts can't send yet.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number", description: "Which connected account to send from" },
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
      "Delete/cancel a calendar event. Get the event_id from list_upcoming_events first. Confirm with the user via ask_user_choice(mode=\"confirm\") before deleting unless they were explicit about which event — don't ask in prose.",
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
    name: "search_memory",
    description:
      "Search everything you've ever remembered about the user via the remember tool, not just " +
      "what's listed in 'Things you remember about the user' above — that list only shows the most " +
      "recent notes, so an older fact (something from months ago) won't be there but is still " +
      "searchable here. Call this when the user references something they told you before that you " +
      "don't see in your current context, e.g. 'what did I say my allergy was'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for" },
        limit: { type: "number", description: "Max notes to return, default 10" },
      },
      required: ["query"],
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
        triggerAt: {
          type: "string",
          description:
            "Optional ISO 8601 date/datetime. Set this only if what the user shared has a natural " +
            "future trigger point — a deadline, a recurring commitment, a stated future plan. Leave " +
            "unset for ordinary facts or preferences with no time dimension. Setting this will send " +
            "the user a WhatsApp message at that time, so only set it when they'd genuinely want to " +
            "be reminded — and mention to them that you've set a reminder.",
        },
        entity_name: {
          type: "string",
          description:
            "Optional. Only set this when the note is about a specific, nameable, recurring subject " +
            "the user might ask about again by name (a person, place, project, etc) — not for " +
            "one-off preferences with no clear subject. The name to file this note under.",
        },
        entity_type: {
          type: "string",
          description:
            "Required if entity_name is set. Free-text category for the subject, e.g. 'person', " +
            "'place', 'project' — your own words, no fixed list.",
        },
        relates_to: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional. Names of other entities this one relates to. Only existing entities are " +
            "linked; names that don't match anything are ignored.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "flag_unmet_request",
    description:
      "Call this (alongside your normal honest reply to the user, same turn) whenever the user asked for something you genuinely can't do with your current tools/capabilities — not for things you can do but haven't yet, and not for ordinary clarifying questions. Give a one-sentence summary of what they wanted and why you couldn't help, so the team can see what to build next.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One sentence: what they wanted and why you couldn't help" },
      },
      required: ["summary"],
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
    name: "send_document",
    description:
      "Send the original photo/file of a previously saved document back to the user on WhatsApp — e.g. 'send me that photo again' or 'can I get the original image of my license'. Only use this when the user wants the actual file back, not just its extracted details (which you can already answer from search_documents/list_recent_documents). Find the right document's id with search_documents or list_recent_documents first. Only works in a WhatsApp conversation — if there's no original photo (e.g. a saved link or email-body receipt), this will say so.",
    input_schema: {
      type: "object",
      properties: {
        document_id: { type: "number", description: "The document's id, from search_documents/list_recent_documents" },
      },
      required: ["document_id"],
    },
  },
  {
    name: "search_conversation_history",
    description:
      "Search the full WhatsApp conversation history with the user, not just the recent messages " +
      "and the rolling summary already in your context — call this when the user references " +
      "something they told you earlier (a name, a decision, a date, a specific fact) that isn't in " +
      "what you can currently see, instead of saying you don't have it or guessing. Only available " +
      "in a WhatsApp conversation. Every term in the query must appear in the same message to " +
      "match, so one or two distinctive keywords (a name, a place, a specific number) works far " +
      "better than a full sentence — a whole natural-language question will usually match nothing.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword(s) to search for" },
        limit: { type: "number", description: "Max messages to return, default 20" },
      },
      required: ["query"],
    },
  },
  {
    name: "extract_email_attachment",
    description:
      "Download one attachment from an email and run it through the same extraction pipeline as a WhatsApp photo/PDF — saves it as a document and, if it's a flight/hotel booking or a receipt, adds a structured record to list_bookings/list_expenses. Call this when the user asks about a booking, ticket, or receipt that's attached to an email you found via get_message, rather than just reading the email body — an email attachment is never extracted automatically. Use the email's account_id/message_id and the attachment's position from get_message's attachments field.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "number" },
        message_id: { type: "string" },
        attachment_index: {
          type: "number",
          description: "The attachment's `index` from get_message's attachments field (1 for the first attachment listed, 2 for the second, etc.) — not a filename or id.",
        },
      },
      required: ["account_id", "message_id", "attachment_index"],
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
  {
    name: "set_briefing_preferences",
    description:
      "Update what the user's morning briefing includes and when it's sent. Their unread mail and today's calendar are always included and don't need to be requested. Call this whenever the user tells you what they'd like added — news, business headlines, weather, market tickers — or when they give a send time. This is a patch: only pass the fields the user actually mentioned, anything omitted keeps its current value.",
    input_schema: {
      type: "object",
      properties: {
        include_weather: { type: "boolean" },
        weather_location: { type: "string", description: "City or place name for the weather segment." },
        include_news: { type: "boolean" },
        topics: {
          type: "array",
          items: { type: "string", enum: Object.keys(NEWS_TOPICS) },
          description: `News topics to include. One or more of: ${Object.keys(NEWS_TOPICS).join(", ")}.`,
        },
        include_markets: { type: "boolean" },
        tickers: {
          type: "array",
          items: { type: "string" },
          description: "Ticker symbols to include in the briefing. Omit for the major indices.",
        },
        proactive: { type: "boolean", description: "Whether to push the briefing automatically each day." },
        send_time: { type: "string", description: '24h "HH:MM", server-local time.' },
      },
    },
  },
  {
    name: "set_tool_enabled",
    description:
      "Turn an optional tool on or off for the user — currently Microsoft Teams chat search and the travel/Schengen day tracker. Call this when the user asks to use, enable, disable, or stop using one of these.",
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", enum: TOOL_KEYS, description: "Which tool to toggle." },
        enabled: { type: "boolean" },
      },
      required: ["tool", "enabled"],
    },
  },
  {
    name: "connect_xero",
    description:
      "Save the user's Xero forwarding email address. Once this is saved, receipts they send that get filed under the 'receipts' category and yield a recognized expense are automatically emailed to this address in the background (via their connected Gmail) — no further action needed from them or from you. Call this ONLY once the user has actually told you the address in this conversation — never guess or invent one. If they ask to 'connect Xero' / 'set up Xero' and haven't given the address yet, first explain that Xero gives every account its own unique forwarding email (in Xero: Business > Bills to pay, or Accounting > Bills, look for the 'email bills to this address' address) and ask them to paste it — then call this tool with exactly what they send.",
    input_schema: {
      type: "object",
      properties: {
        forwarding_email: {
          type: "string",
          description: "The Xero-provided forwarding email address, exactly as the user gave it.",
        },
      },
      required: ["forwarding_email"],
    },
  },
  {
    name: "respond_to_invoice_forward_prompt",
    description:
      "Call this when the user is replying to a 'looks like an invoice — reply yes and I'll forward it to Xero' prompt from a recent WhatsApp alert (check your context for a pending Xero invoice confirmation — only call this if one is actually present; if there's none pending, their message is about something else, so don't call this speculatively). Set confirm=true for an affirmative reply (yes, go ahead, please do, sure), confirm=false for a decline (no, skip, ignore, not now). You never choose which email or attachment this acts on — that was already fixed when the alert was sent.",
    input_schema: {
      type: "object",
      properties: {
        confirm: { type: "boolean" },
      },
      required: ["confirm"],
    },
  },
  {
    name: "ask_user_choice",
    description:
      "Ask the user a closed-set question and get back a real tappable answer (WhatsApp buttons or a list) instead of free text. Call this ALONE — the only tool call in your turn — after you already have whatever information you need (e.g. call search_contacts first, look at the results, then call ask_user_choice in your NEXT turn once you can see them). Use mode='confirm' before a bulk or destructive action: pass confirm_tool and confirm_input set to the exact tool call you'd make if the user taps Yes — you do not execute it yourself, it only runs if they tap it. By default this renders Yes/No buttons and a No tap just cancels; pass decline_tool/decline_input to run a different tool instead of cancelling (e.g. save as a draft instead of sending), and yes_label/no_label to relabel the buttons for what they actually do (e.g. 'Send'/'Leave in Drafts'). Pass editable=true to add a third 'Edit' button for anything the user might want to revise instead of just accepting or declining (e.g. sending an email) — tapping it comes back to you as a normal follow-up message asking what to change, same as a resume tap. Use mode='resume' to disambiguate between 2-10 candidates (e.g. multiple contacts matching a name): pass one option per candidate; whichever one is tapped comes back to you as a normal follow-up message.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to show the user." },
        mode: { type: "string", enum: ["confirm", "resume"] },
        options: {
          type: "array",
          description:
            "Required for mode='resume': 2-10 choices to present. Not used for mode='confirm'.",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
          },
        },
        confirm_tool: {
          type: "string",
          description: "Required for mode='confirm': the exact tool name to call if the user taps Yes.",
        },
        confirm_input: {
          type: "object",
          description: "Required for mode='confirm': the exact input to pass to confirm_tool if the user taps Yes.",
        },
        decline_tool: {
          type: "string",
          description:
            "mode='confirm' only, optional: a tool to call if the user taps No, instead of just cancelling — e.g. create_email_draft when declining to send.",
        },
        decline_input: {
          type: "object",
          description: "The input to pass to decline_tool if given.",
        },
        editable: {
          type: "boolean",
          description: "mode='confirm' only, optional: adds a third 'Edit' button. Default false.",
        },
        yes_label: { type: "string", description: "mode='confirm' only, optional: overrides the 'Yes' button label." },
        no_label: { type: "string", description: "mode='confirm' only, optional: overrides the 'No' button label." },
      },
      required: ["question", "mode"],
    },
  },
  {
    name: "react_to_message",
    description:
      "React to the user's message/upload with a single emoji instead of sending a text reply — use for a low-signal acknowledgment that doesn't need a response (e.g. \"ok\", \"thanks\", \"👍\", a short confirmation) where a full reply would feel unnecessary. Call this ALONE, as the only tool call and with no other text in your turn — if you have anything to say, say it as a normal text reply instead of calling this.",
    input_schema: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "A single emoji, e.g. \"👍\"." },
      },
      required: ["emoji"],
    },
  },
  // Anthropic's built-in web search — this is a *server* tool, not a custom one: Anthropic runs
  // the search itself and folds a web_search_tool_result block into this same response, so it
  // never produces a client-side tool_use block and never reaches runTool's switch below. Always
  // on for every user (no per-owner flag, unlike teams/travel) — see buildRules for when the
  // model should reach for it.
  // max_uses caps how many searches a single user message can trigger — a blast-radius/cost
  // guardrail, since each search is billed per use and a confused model can otherwise loop on
  // reformulated queries. 5 is comfortably above what a normal "find me a hotel near X" answer
  // needs.
  {
    name: "web_search",
    type: "web_search_20250305",
    max_uses: 5,
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

export function buildToolsForOwner(ownerId: number): Anthropic.ToolUnion[] {
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

// Real Gmail/Graph attachment ids are ~200-300 character opaque tokens. Models reliably fail to
// copy a token that long back verbatim in a later tool call — they reproduce the first several
// characters correctly and then drift/fabricate the rest, which is exactly what was causing
// every real extract_email_attachment call to fail with "invalid id" even though the id had been
// right there in the previous tool result. Hiding the raw id and giving the model a 1-based
// index instead (matching display order) sidesteps the problem entirely — a single digit can't
// be mistyped the same way, and extract_email_attachment resolves the index back to the real id
// server-side.
// list_recent_messages/search_messages results are for scanning, not reading — the model can
// always call get_message for the full body (see messageForModel below, which is deliberately
// NOT applied here since it would also touch get_message's single-message result). Sending 30
// full-length snippets, then resending them at full price on every later turn of the same
// message's tool loop (see runAssistantChat), was the single biggest driver of assistant token
// cost — see feature-to-do/token-cost-reduction.md #1.
// Exported for its own unit test — same reasoning as messageForModel below.
export const LIST_SNIPPET_MAX_LENGTH = 150;
export function trimSnippetForList(message: UnifiedMessage): UnifiedMessage {
  if (message.snippet.length <= LIST_SNIPPET_MAX_LENGTH) return message;
  return { ...message, snippet: message.snippet.slice(0, LIST_SNIPPET_MAX_LENGTH) + "…" };
}

// Exported for its own unit test — same reasoning as forModel/resolveDocumentCategory
// elsewhere: this is the one bit of pure logic worth testing directly, without needing a live
// hub/provider call in the loop.
export function messageForModel(message: UnifiedMessage | null): unknown {
  if (!message?.attachments) return message;
  return {
    ...message,
    attachments: message.attachments.map((a, i) => ({
      index: i + 1,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
  };
}

const TOOL_NAME_TO_KEY: Record<string, ToolKey> = {
  list_recent_chats: "teams",
  search_chats: "teams",
  list_travel_checkins: "travel",
  count_travel_days: "travel",
};

// phone is optional and WhatsApp-only (web chat/eval callers omit it) — used only by tools that
// need to send something directly to the user's chat (currently just send_document).
export async function runTool(
  ownerId: number,
  name: string,
  input: Record<string, unknown>,
  phone?: string
): Promise<unknown> {
  const requiredKey = TOOL_NAME_TO_KEY[name];
  if (requiredKey && !getEnabledTools(ownerId).has(requiredKey)) {
    return { error: `tool not enabled: ${name}` };
  }
  switch (name) {
    case "list_recent_messages":
      return (
        await hubListMessages(ownerId, {
          accountId: input.account_id as number | undefined,
          limit: (input.limit as number | undefined) ?? LIST_RECENT_MESSAGES_DEFAULT_LIMIT,
        })
      ).map(trimSnippetForList);
    case "search_messages":
      return (
        await hubListMessages(ownerId, {
          query: input.query as string,
          accountId: input.account_id as number | undefined,
          limit: (input.limit as number | undefined) ?? SEARCH_MESSAGES_DEFAULT_LIMIT,
        })
      ).map(trimSnippetForList);
    case "get_message":
      return messageForModel(
        await hubGetMessage(ownerId, input.account_id as number, input.message_id as string)
      );
    case "list_upcoming_events":
      return hubListEvents(ownerId, (input.days as number | undefined) ?? 7);
    case "find_free_time": {
      const days = (input.days as number | undefined) ?? 7;
      const events = await hubListEvents(ownerId, days);
      return findFreeSlots(events, {
        days,
        durationMinutes: (input.duration_minutes as number | undefined) ?? 30,
        earliestHour: (input.earliest_hour as number | undefined) ?? 9,
        latestHour: (input.latest_hour as number | undefined) ?? 18,
      });
    }
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
    case "send_email":
      return hubSendMessage(
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
    case "remember": {
      const note = input.note as string;
      addMemoryNote(ownerId, note, input.triggerAt as string | undefined);

      const entityName = input.entity_name as string | undefined;
      const entityType = input.entity_type as string | undefined;
      if (entityName && entityType) {
        const entity = findOrCreateEntity(ownerId, entityType, entityName);
        appendEntityNote(ownerId, entity.id, note);

        const relatesTo = (input.relates_to as string[] | undefined) ?? [];
        for (const otherName of relatesTo) {
          const other = findEntityByName(ownerId, otherName);
          if (other) {
            linkRecords(ownerId, {
              relation: "relates_to",
              from: { type: "entity", id: entity.id },
              to: { type: "entity", id: other.id },
            });
          }
        }
      }
      return { ok: true };
    }
    case "search_memory":
      return searchMemoryNotes(
        ownerId,
        input.query as string,
        (input.limit as number | undefined) ?? SEARCH_MEMORY_DEFAULT_LIMIT
      );
    case "flag_unmet_request":
      addUnmetRequest(ownerId, input.summary as string, phone ? "whatsapp" : "web");
      return { ok: true };
    case "list_needs_attention":
      return hubFlaggedMessages(ownerId);
    case "search_documents":
      return searchDocuments(ownerId, input.query as string).map(forModel);
    case "list_recent_documents":
      return listDocuments(ownerId, (input.limit as number | undefined) ?? 10).map(forModel);
    case "send_document": {
      if (!phone) {
        return { error: "Sending the original file back is only available in a WhatsApp conversation." };
      }
      const result = await sendSavedDocumentFile(ownerId, phone, input.document_id as number);
      if (!result.ok) {
        const messages: Record<typeof result.reason, string> = {
          not_found: "No saved document with that id — check search_documents/list_recent_documents for the right one.",
          no_original_file: "There's no original photo/file for this one — it was saved from a link or email text, not a photo.",
          send_failed: "Couldn't send that file — it may be too large or an unsupported type for WhatsApp.",
        };
        return { error: messages[result.reason] };
      }
      return { ok: true };
    }
    case "search_conversation_history": {
      if (!phone) {
        return { error: "Searching conversation history is only available in a WhatsApp conversation." };
      }
      // input.limit is model-supplied and untrusted: SQLite treats a negative LIMIT as
      // "unbounded", and whatsapp_messages grows forever on a long-running account, so clamp
      // to a sane range rather than passing it straight through.
      const clampedLimit = Math.min(
        Math.max(1, Number(input.limit) || SEARCH_CONVERSATION_HISTORY_DEFAULT_LIMIT),
        50
      );
      return searchWhatsAppHistory(ownerId, phone, input.query as string, clampedLimit);
    }
    case "extract_email_attachment": {
      const result = await ingestEmailAttachment({
        ownerId,
        accountId: input.account_id as number,
        messageId: input.message_id as string,
        attachmentIndex: input.attachment_index as number,
      });
      if (!result.ok) {
        return result.reason === "invalid_index"
          ? { error: "That attachment index doesn't match any attachment on this email — call get_message again and use the `index` shown for the attachment you want." }
          : { error: "Couldn't download that attachment — it may be too large for direct download, or the account's access may have expired." };
      }
      return { ...forModel(result.doc), alreadyExtracted: result.alreadyExtracted };
    }
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
    case "set_briefing_preferences": {
      const current = getBriefingSettings(ownerId);
      const requestedTopics = (input.topics as string[] | undefined)?.filter((t): t is NewsTopic =>
        Object.prototype.hasOwnProperty.call(NEWS_TOPICS, t)
      );
      saveBriefingSettings(ownerId, {
        ...current,
        ...(input.include_weather !== undefined ? { includeWeather: input.include_weather as boolean } : {}),
        ...(input.weather_location !== undefined ? { weatherLocation: input.weather_location as string } : {}),
        ...(input.include_news !== undefined ? { includeNews: input.include_news as boolean } : {}),
        ...(requestedTopics !== undefined ? { topics: requestedTopics } : {}),
        ...(input.include_markets !== undefined ? { includeMarkets: input.include_markets as boolean } : {}),
        ...(input.tickers !== undefined ? { tickers: input.tickers as string[] } : {}),
        ...(input.proactive !== undefined ? { proactive: input.proactive as boolean } : {}),
        ...(input.send_time !== undefined ? { sendTime: input.send_time as string } : {}),
      });
      return { ok: true };
    }
    case "set_tool_enabled": {
      const tool = input.tool as string;
      if (!TOOL_KEYS.includes(tool as ToolKey)) {
        return { error: `unknown tool: ${tool}` };
      }
      setToolEnabled(ownerId, tool as ToolKey, !!input.enabled);
      return { ok: true };
    }
    case "connect_xero": {
      try {
        setXeroForwardingEmail(ownerId, input.forwarding_email as string);
        return { ok: true };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }
    case "respond_to_invoice_forward_prompt": {
      const pending = getPendingInvoiceForward(ownerId);
      if (!pending) return { error: "No pending invoice confirmation to respond to." };
      clearPendingInvoiceForward(ownerId);
      if (!input.confirm) return { ok: true, forwarded: false };

      const message = await hubGetMessage(ownerId, pending.accountId, pending.messageId);
      if (message?.attachments?.length) {
        const results = await Promise.all(
          message.attachments.map((_att, i) =>
            ingestEmailAttachment({
              ownerId,
              accountId: pending.accountId,
              messageId: pending.messageId,
              attachmentIndex: i + 1,
            })
          )
        );
        return { ok: true, forwarded: true, attachmentsProcessed: results.length };
      }

      if (message?.body?.trim()) {
        const result = await ingestEmailBodyReceipt({
          ownerId,
          accountId: pending.accountId,
          messageId: pending.messageId,
          subject: pending.subject,
          bodyText: message.body,
        });
        if (!result.ok) {
          return { error: "Looked at that email but couldn't find a clear amount/vendor to record — nothing was forwarded." };
        }
        return { ok: true, forwarded: true, attachmentsProcessed: 0 };
      }

      return { error: "Couldn't find that email anymore — it may have been deleted or moved." };
    }
    case "list_expenses":
      return listEntities<ExpenseData>(ownerId, { type: "expense" })
        .slice(0, (input.limit as number | undefined) ?? 50)
        .map((e) => ({ id: e.id, ...e.data, status: e.status, confidence: e.confidence }));
    case "list_bookings": {
      const rows = listEntities<BookingData>(ownerId, { type: "booking" });
      const kind = input.kind as string | undefined;
      return (kind ? rows.filter((e) => e.data.kind === kind) : rows)
        .slice(0, (input.limit as number | undefined) ?? 50)
        .map((e) => ({ id: e.id, ...e.data, status: e.status, confidence: e.confidence }));
    }
    case "get_spending_digest": {
      const untilMs = input.until_date ? new Date(input.until_date as string).getTime() : Date.now();
      const sinceMs = input.since_date
        ? new Date(input.since_date as string).getTime()
        : untilMs - 30 * 24 * 60 * 60 * 1000;
      const priorUntilMs = sinceMs - 1;
      const priorSinceMs = priorUntilMs - (untilMs - sinceMs);
      const expenses = listEntities<ExpenseData>(ownerId, { type: "expense" });
      const bookings = listEntities<BookingData>(ownerId, { type: "booking" });
      return buildSpendingDigest(expenses, bookings, { sinceMs, untilMs, priorSinceMs, priorUntilMs });
    }
    case "create_trip": {
      const data: TripData = {
        label: String(input.label ?? "").trim(),
        startDate: String(input.start_date ?? "").trim(),
        endDate: input.end_date ? String(input.end_date).trim() : null,
      };
      const validation = validateTrip(data, { uploadedAt: new Date() });
      if (validation.severity === "reject") {
        return { error: `Could not create trip: ${validation.issues.join(" ")}` };
      }
      const entity = saveEntity<TripData>(ownerId, {
        type: "trip",
        data,
        confidence: validation.confidence,
        status: validation.severity === "warn" ? "needs_review" : "active",
      });
      return { id: entity.id, ...entity.data, status: entity.status, confidence: entity.confidence };
    }
    case "link_to_trip": {
      const tripId = input.trip_id as number;
      const trip = getEntity(ownerId, tripId);
      if (!trip || trip.type !== "trip") return { error: `No trip with id ${tripId}.` };
      const entityId = input.entity_id as number | undefined;
      const documentId = input.document_id as number | undefined;
      if (entityId == null && documentId == null) {
        return { error: "Provide either entity_id or document_id to link." };
      }
      if (entityId != null) {
        if (!getEntity(ownerId, entityId)) return { error: `No entity with id ${entityId}.` };
        const link = linkRecords(ownerId, {
          relation: "belongs_to",
          from: { type: "entity", id: entityId },
          to: { type: "entity", id: tripId },
        });
        return { ok: true, link };
      }
      if (!getDocument(ownerId, documentId!)) return { error: `No document with id ${documentId}.` };
      const link = linkRecords(ownerId, {
        relation: "relates_to",
        from: { type: "document", id: documentId! },
        to: { type: "entity", id: tripId },
      });
      return { ok: true, link };
    }
    case "get_trip_contents": {
      const tripId = input.trip_id as number;
      const trip = getEntity<TripData>(ownerId, tripId);
      if (!trip || trip.type !== "trip") return { error: `No trip with id ${tripId}.` };
      const entities = getRelatedEntities<Record<string, unknown>>(ownerId, { type: "entity", id: tripId });
      const documents = getLinksTo(ownerId, "entity", tripId)
        .filter((l) => l.fromType === "document")
        .map((l) => getDocument(ownerId, l.fromId))
        .filter((d): d is DocumentRow => !!d)
        .map((d) => ({ id: d.id, title: d.title, filename: d.filename, category: d.category }));
      return {
        trip: { id: trip.id, ...trip.data, status: trip.status },
        entities: entities.map((e) => ({ id: e.id, type: e.type, ...e.data, status: e.status })),
        documents,
      };
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

export interface PendingChoiceButton {
  key: string;
  label: string;
}

export interface AssistantReply {
  text: string;
  choice?: {
    actionId: string;
    question: string;
    mode: "confirm" | "resume";
    buttons: PendingChoiceButton[];
  };
  reaction?: {
    emoji: string;
  };
}

// Builds the AssistantReply for an ask_user_choice tool call and persists the pending_actions
// row it refers to. Never called for anything else — see runAssistantChat's loop below, which
// intercepts ask_user_choice before it would otherwise reach runTool's generic dispatch (runTool
// has no case for it and returns "unknown tool" if ever called directly — see its test).
function buildChoiceReply(ownerId: number, input: Record<string, unknown>): AssistantReply {
  const question = input.question as string;
  const mode = input.mode as "confirm" | "resume";

  if (mode === "confirm") {
    const tool = input.confirm_tool as string;
    const confirmInput = (input.confirm_input as Record<string, unknown>) ?? {};
    const declineTool = input.decline_tool as string | undefined;
    const declineInput = (input.decline_input as Record<string, unknown>) ?? {};
    const editable = input.editable === true;
    const yesLabel = (input.yes_label as string | undefined) || "Yes";
    const noLabel = (input.no_label as string | undefined) || "No";
    const actionId = createPendingAction(
      ownerId,
      "confirm",
      question,
      JSON.stringify({ tool, input: confirmInput, declineTool, declineInput })
    );
    const buttons: PendingChoiceButton[] = [
      ...(editable ? [{ key: "edit", label: "Edit" }] : []),
      { key: "yes", label: yesLabel },
      { key: "no", label: noLabel },
    ];
    // Only the plain default (no custom labels, no edit option — every confirm-required tool
    // other than send_email) keeps the original terse "Reply yes or no." phrasing verbatim, so
    // existing callers/tests see byte-identical text. Anything customized gets the numbered-list
    // phrasing resume mode already uses, since "yes or no" no longer describes the buttons.
    const text =
      !editable && yesLabel === "Yes" && noLabel === "No"
        ? `${question} Reply yes or no.`
        : `${question}\n${buttons.map((b, i) => `${i + 1}. ${b.label}`).join("\n")}`;
    return {
      text,
      choice: { actionId, question, mode: "confirm", buttons },
    };
  }

  const options = (input.options as { label: string }[] | undefined) ?? [];
  const actionId = createPendingAction(
    ownerId,
    "resume",
    question,
    JSON.stringify({ options: options.map((o) => o.label) })
  );
  return {
    text: `${question}\n${options.map((o, i) => `${i + 1}. ${o.label}`).join("\n")}`,
    choice: {
      actionId,
      question,
      mode: "resume",
      buttons: options.map((o, i) => ({ key: String(i), label: o.label })),
    },
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function buildRules(enabled: Set<ToolKey>): string {
  const base = [
    "- Always look up real data with your tools before answering questions about email, calendar, or files — never invent contents.",
    "- ask_user_choice renders real tappable buttons/a list on WhatsApp instead of asking in prose — use it for confirm-before-destructive-action and for disambiguating between candidates (see the archive and search_contacts rules below for the two concrete cases). Call it alone, as the only tool call in your turn.",
    "- Never state that something does NOT exist (no booking, no email, nothing on file, calendar is empty, etc.) without calling the relevant tool in THIS turn first. You do not retain tool results from earlier turns — only your own past reply text — so a memory of having checked before is not verification. If a user pushes back on something you said, that is a signal to re-run the tool, not to just apologize or reverse yourself from reasoning alone.",
    "- After re-running a tool in response to pushback, check what it actually returned before deciding how to respond: if it confirms your original answer was correct, just say so plainly (e.g. \"confirmed — it's still Feb 8\") and move on. Don't apologize or claim you were reciting/guessing/pulling from context you shouldn't have relied on when the tool result backs up what you said — that's confusing and untrue when the original answer was grounded. Reserve the apology for when re-checking actually turns up something different from what you first said.",
    "- list_bookings/list_expenses only cover confirmations and receipts that were already saved as a document AND successfully extracted into a structured record — they do NOT search email. Before telling the user there's no hotel, flight, car rental, invoice, or payment due, also check search_messages/list_recent_messages: the confirmation or invoice email may exist even though nothing has been extracted into list_bookings/list_expenses yet. An empty list_bookings/list_expenses result on its own is not enough to say something doesn't exist.",
    "- For a broad or topic-level search (a country, region, or trip name — e.g. \"South America\", \"my Lisbon trip\"), call search_messages multiple times with different concrete sub-terms — city/place names, likely vendor names (airlines, hotels, booking sites), reference codes you already know — before concluding nothing was found. A single broad query is not sufficient; a broad topic phrase rarely appears verbatim in a real subject line.",
    '- Whenever you write an email on the user\'s behalf (a new email, or a reply), never send or draft it silently. Instead call ask_user_choice ALONE with the full draft shown IN the question text itself (any other text you write this same turn is discarded — see ask_user_choice\'s own description) — e.g. question="To: jane@x.com\\nSubject: Re: Thursday\\n\\n<body>\\n\\nReady to send this?" — with mode="confirm", confirm_tool="send_email", confirm_input={account_id, to, subject, body}, editable=true, yes_label="Send", no_label="Leave in Drafts", decline_tool="create_email_draft", decline_input={account_id, to, subject, body}. That renders Edit / Send / Leave in Drafts. Send it only if they tap Send — Leave in Drafts saves it in their mailbox without sending, and Edit comes back to you as a follow-up message asking what to change (draft the revised content and ask again the same way). send_email only works for Gmail accounts — for an Outlook account, skip the ask and call create_email_draft directly instead, telling the user Outlook sending isn\'t supported yet so it\'s saved as a draft for them to send themselves.',
    "- You can create, edit, and delete calendar events directly on the user's own calendar — these are low-risk and reversible. You can never invite other people to an event; calendar events you create are personal-only.",
    '- You can archive emails and apply labels/categories directly — archiving is fully reversible (the email is just removed from the inbox, never deleted) so you don\'t need to ask permission first, but when the query is broad or ambiguous (e.g. "archive everything" with no filter), confirm first with ask_user_choice(mode="confirm", confirm_tool="archive_messages", confirm_input=<the exact call>) instead of asking in prose.',
    "- Use search_contacts to resolve a name to an email address before drafting to someone when you don't already have their address.",
    "- If search_contacts (or any lookup) returns more than one plausible match and it's not obvious which one is meant, use ask_user_choice(mode=\"resume\") with one option per candidate instead of listing them in prose and waiting for a typed reply.",
    "- Use the remember tool proactively whenever the user shares something worth recalling later (preferences, which account is which, standing instructions) — don't wait to be asked.",
    "- When a remember note is about a specific, nameable, recurring subject (a person, place, project, etc) the user might ask about again by name, pass entity_name + entity_type on that same remember call so it files onto a lookup-able entity instead of only a flat note — don't do this for one-off preferences with no clear subject.",
    "- Use flag_unmet_request whenever you have to tell the user you can't do something — call it in the same turn as your reply, don't wait to be asked.",
    '- Use search_documents/list_recent_documents when the user asks about something they photographed or sent via WhatsApp (boarding passes, licenses, tickets, receipts) — e.g. "when did I fly to X" or "what\'s the code on my license".',
    "- If the user wants the actual photo/file back rather than just its details (e.g. \"send me that photo again\", \"can I get the original image\"), find the right document with search_documents/list_recent_documents first, then call send_document with its id.",
    "- Use search_conversation_history when the user references something they told you earlier (a name, a decision, a date, a specific fact) that isn't in your current context — the visible recent messages or the conversation summary above — instead of saying you don't have it or guessing. WhatsApp-only, same as send_document. Every term must appear in the same message to match, so a full sentence often returns nothing even when the fact is there — if a call comes back empty, retry with different single keywords pulled from the user's question (a name, a place, a specific number) before telling them you don't have it.",
    "- When the user asks about a trip, booking, or receipt and get_message shows a relevant attachment (ticket, confirmation, visa, invoice), call extract_email_attachment on it yourself, immediately, without asking first — the same way you'd read the email body without asking. Do this for every relevant attachment you find in the same turn, not one at a time. Only ask first if there are an unusually large number of attachments (10+) to extract at once. Don't just describe the attachment's filename and stop there, and don't stop to ask permission to do something this low-risk and reversible.",
    "- If extract_email_attachment fails for an attachment, don't just relay a generic failure to the user — retry it once, and if it still fails, say so plainly with the vendor/subject so they know exactly which one needs a manual forward, rather than leaving them to guess.",
    "- Use get_news for news/current-events questions. Only report headlines the tool actually returned — never supplement with your own general knowledge or training data, even for well-known ongoing events. Fabricating a headline is a serious error, same as with any other tool's data.",
    "- Use get_weather and get_markets for weather and stock/index questions. The same rule applies: report only what the tool returned. Never state a price, a percentage move, or a forecast you didn't just fetch.",
    "- If the user asks to connect/set up Xero: Xero gives each account a unique forwarding email (in Xero: Business > Bills to pay, or Accounting > Bills — the 'email bills to this address' address). Ask them to paste it, then call connect_xero with exactly what they send — never guess or fill in an address yourself. Once connected, receipts they send that are filed under 'receipts' and yield a recognized expense are forwarded to Xero automatically in the background — this already works, don't tell the user it's unbuilt or manual.",
    "- There are TWO separate paths to Xero, both already built: (1) a WhatsApp photo/PDF filed as a receipt forwards automatically, no confirmation needed. (2) Email is scanned periodically (every few minutes) for invoice-looking automated mail; ONLY when that scan actually flags one do you get a pending confirmation to offer 'reply yes to forward' (see below) — the scan hasn't necessarily run yet or matched a given email, so no pending confirmation does NOT mean email invoices are unsupported. If the user asks about a specific email invoice with nothing pending, never claim this feature only works for WhatsApp — instead offer to call extract_email_attachment on it directly, which also triggers the same automatic Xero forwarding once it's saved as a receipt with a real expense, just without the alert/confirm step.",
    "- Use web_search for questions you don't have another tool for — nearby places (hotels, restaurants, attractions), current prices/events, or anything else that needs a live answer from the web rather than what you already know. Say plainly that you searched the web rather than presenting the answer as verified fact. When you recommend a specific place, include a Google Maps link built as https://www.google.com/maps/search/?api=1&query=<url-encoded name and address/area> so the user can open it directly — never invent coordinates, and never claim you've sent a location pin (you haven't).",
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

export function buildSystemPrompt(ownerId: number, conversationSummary?: string): string {
  const accounts = listAccounts(ownerId);
  const persona = getSetting(ownerId, "persona");
  const name = getSetting(ownerId, "assistant_name") ?? "Marlowe";

  const accountList = accounts.length
    ? accounts.map((a) => `- id ${a.id}: ${a.email} (${a.provider})`).join("\n")
    : "(none connected — tell the user to connect an account on the Setup page first)";

  const folders = listLocalFolders(ownerId);
  const folderList = folders.length
    ? folders.map((f) => `- ${f.path}`).join("\n")
    : "(none configured)";

  const memories = listRecentMemoryNotes(ownerId).reverse();
  const memoryList = memories.length
    ? memories
        .map(
          (m) =>
            `- ${m.content}${
              m.triggerAt
                ? ` (reminder set for ${new Date(m.triggerAt).toDateString()}${
                    m.lastSurfacedAt ? ", already sent" : ""
                  })`
                : ""
            }`
        )
        .join("\n")
    : "(nothing remembered yet)";

  const xeroEmail = getXeroForwardingEmail(ownerId);
  const xeroStatus = xeroEmail
    ? `Xero forwarding address on file: ${xeroEmail}. Receipts filed under 'receipts' that yield a recognized expense are already being forwarded there automatically (via connected Gmail) — this is live, not a future feature.`
    : "Xero: not connected — no forwarding address saved yet.";

  const pendingInvoice = getPendingInvoiceForward(ownerId);
  const pendingInvoiceStatus = pendingInvoice
    ? `Pending Xero invoice confirmation: a WhatsApp alert about "${pendingInvoice.subject}" asked the user to reply "yes" to forward it to Xero. If their latest message is answering that (yes/no/go ahead/skip), call respond_to_invoice_forward_prompt with confirm accordingly. If it's about something else, ignore this.`
    : "";

  // Mid-onboarding context, keyed off the WhatsApp post-connect chain's own pending step
  // (postConnectSetup.ts / db/store.ts's pending_setup) rather than whether briefing settings
  // exist yet — that flag flips true the instant the yes/no briefing question is answered, before
  // the user has actually answered the content question below it, which used to make this note
  // disappear before it was ever useful. Each of these two free-text steps forwards the user's
  // reply straight into this same runAssistantChat call (see postConnectSetup.ts's
  // advancePastFreeTextStep), then sends the next scripted question itself once this reply is
  // sent — the note only needs to shape this one turn, not chain anything further.
  const pendingSetupStep = getPendingSetup(ownerId);
  const onboardingNote =
    pendingSetupStep === "ask_first_task"
      ? "The user is mid-setup and was just asked if there's anything they'd like help with before " +
        "finishing. Answer their request normally — a scripted setup question will follow " +
        "automatically right after your reply, so don't try to ask it yourself."
      : pendingSetupStep === "ask_briefing_content"
        ? "The user is mid-setup, just said yes to a daily briefing, and was asked what to include " +
          "(news, business headlines, weather). Call set_briefing_preferences with whatever they " +
          "said and confirm briefly — a scripted setup question about other tools will follow " +
          "automatically right after your reply, so don't ask about that yourself."
        : "";

  return [
    `You are ${name}, a personal assistant that manages the user's connected accounts. Today's date is ${new Date().toDateString()}.`,
    persona ? `The user described how they want you to behave:\n${persona}` : "",
    `Connected accounts:\n${accountList}`,
    `Local computer folders searchable by file name:\n${folderList}`,
    `Things you remember about the user. You may naturally bring up one of these when it's ` +
      `genuinely relevant to what's being discussed — the way someone who was actually paying ` +
      `attention would — without forcing it or repeating something you've already brought up ` +
      `this conversation:\n${memoryList}`,
    xeroStatus,
    pendingInvoiceStatus,
    conversationSummary
      ? `Earlier in this conversation, before what's shown in the message history below:\n${conversationSummary}`
      : "",
    onboardingNote,
    buildRules(getEnabledTools(ownerId)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The tools+system prefix is already cached (buildToolsForOwner / the system block below), but
// `messages` itself is not — within one runAssistantChat's loop, every turn otherwise re-pays
// full input price for every earlier turn's tool results, which is the real cost driver (see
// feature-to-do/token-cost-reduction.md #2). Rebuilding from the original `messages` each call
// (rather than mutating it) means it never carries cache_control itself, so there's never more
// than the one breakpoint added here — no risk of exceeding Anthropic's max breakpoints per
// request (2 already used by tools + system) as the array grows turn over turn. Because each
// turn only APPENDS to `messages`, the prefix up to this breakpoint stays byte-identical to what
// the previous turn cached, so it's read back at the cached (not full) rate.
function withMessagesCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const blocks = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
  if (blocks.length === 0) return messages;
  const cachedBlocks = blocks.map((block, i) =>
    i === blocks.length - 1 ? { ...block, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : block
  );
  return [...messages.slice(0, -1), { ...last, content: cachedBlocks }];
}

// A response's visible reply is every text block joined, not just the first one. Picking only the
// first (what this used to do) silently dropped most of a web_search answer: web_search is a
// server tool, so Anthropic folds server_tool_use/web_search_tool_result blocks into the same
// response and the model's prose arrives as MULTIPLE text blocks around them — a short preamble
// ("let me look that up"), then the real answer, itself chunked one block per cited span when
// citations are attached. Joining is also correct for the ordinary single-block case.
function joinTextBlocks(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// phone is optional and WhatsApp-only (web chat/eval callers omit it) — when given, it's used
// purely to look up the rolling conversation summary (services/conversationSummary.ts writes it,
// keyed by phone) to fold into the system prompt. Not otherwise used in this function.
export async function runAssistantChat(
  ownerId: number,
  history: ChatMessage[],
  phone?: string
): Promise<AssistantReply> {
  const anthropic = getClient();
  const conversationSummary = phone ? (getConversationSummary(phone)?.summary ?? undefined) : undefined;
  const system = buildSystemPrompt(ownerId, conversationSummary);

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

  // Summed across every anthropic.messages.create call this invocation makes (the loop below can
  // take up to 8 turns for one user message, e.g. several tool round-trips) and recorded once,
  // via finish() below, rather than once per turn — admins want "how many times was the assistant
  // actually asked something" and "how many tokens did that cost", not internal loop iterations.
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const channel = phone ? "whatsapp" : "web";
  function finish(reply: AssistantReply): AssistantReply {
    recordApiUsage(
      ownerId,
      channel,
      model,
      "assistant_chat",
      usageTotals.inputTokens,
      usageTotals.outputTokens,
      usageTotals.cacheReadTokens,
      usageTotals.cacheCreationTokens
    );
    return reply;
  }

  for (let turn = 0; turn < 8; turn++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      ...(useThinking ? { thinking: { type: "adaptive" as const } } : {}),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: buildToolsForOwner(ownerId),
      messages: withMessagesCacheBreakpoint(messages),
    });
    // response.usage is absent in some existing tests' mocked responses — tolerate that rather
    // than letting a usage-tracking side effect break the actual conversation flow.
    usageTotals.inputTokens += response.usage?.input_tokens ?? 0;
    usageTotals.outputTokens += response.usage?.output_tokens ?? 0;
    // input_tokens above is ONLY the uncached tail — the cached tools+system prefix this loop
    // re-reads on every turn is reported separately here, and it's most of the real bill.
    usageTotals.cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;
    usageTotals.cacheCreationTokens += response.usage?.cache_creation_input_tokens ?? 0;

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    // Anthropic pauses a long-running server-tool turn (web_search) with stop_reason "pause_turn"
    // rather than finishing it — the content so far is complete and valid, and feeding it straight
    // back continues the same turn where it left off. Without this it would fall into the
    // no-tool_use branch below and return whatever partial (often empty) text had been emitted so
    // far, which then reaches sendAssistantReply → whatsappReply.ts's splitIntoChunks as an
    // empty-body send that Meta rejects. Guarded on toolUses.length === 0 so a normal client-side
    // tool_use turn is never diverted here; the existing 8-turn cap already bounds the loop.
    if (toolUses.length === 0 && response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    if (toolUses.length === 0) {
      return finish({ text: joinTextBlocks(response.content) });
    }

    // ask_user_choice is a hard stop, not a tool result to feed back to the model — the system
    // prompt tells the model to call it alone, so any other tool_use blocks in this same
    // response are ignored rather than run.
    const choiceUse = toolUses.find((t) => t.name === "ask_user_choice");
    if (choiceUse) {
      return finish(buildChoiceReply(ownerId, choiceUse.input as Record<string, unknown>));
    }

    // react_to_message is also a hard stop, same shape as ask_user_choice above — one API call
    // in, a reaction out, no tool_result round-trip. Its own instructions tell the model to call
    // it alone; if the model broke that and also wrote text this turn, prefer the visible text
    // over a silent reaction — the user should never see nothing when the model had something to
    // say (same reasoning as the flag_unmet_request + text case below).
    const reactionUse = toolUses.find((t) => t.name === "react_to_message");
    if (reactionUse) {
      const reactionText = joinTextBlocks(response.content);
      if (reactionText) {
        return finish({ text: reactionText });
      }
      const input = reactionUse.input as Record<string, unknown>;
      return finish({ text: "", reaction: { emoji: input.emoji as string } });
    }

    // flag_unmet_request is a fire-and-forget log, not a tool whose result the model needs fed
    // back to keep reasoning — its own instructions tell the model to call it "alongside your
    // normal reply, same turn," meaning the actual reply text is usually already sitting right
    // here in this same response. Without this check, that text was being silently discarded and
    // a second full round-trip (whole system prompt + tools + history resent) paid for just to
    // get the model to repeat itself as plain text — doubling the API cost of every single
    // capability-gap decline. Bug found 2026-08-28, introduced the same day this tool shipped.
    const flagUse = toolUses.find((t) => t.name === "flag_unmet_request");
    const flagText = joinTextBlocks(response.content);
    if (flagUse && flagText && toolUses.length === 1) {
      await runTool(ownerId, "flag_unmet_request", flagUse.input as Record<string, unknown>, phone);
      return finish({ text: flagText });
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (toolUse) => {
        if (CONFIRM_REQUIRED_TOOLS.has(toolUse.name)) {
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content:
              `Error: ${toolUse.name} requires user confirmation before it can run — it was not ` +
              `executed. Call ask_user_choice(mode="confirm", confirm_tool="${toolUse.name}", ` +
              `confirm_input=<the same input>) instead of calling this tool directly.`,
            is_error: true,
          };
        }
        try {
          const result = await runTool(ownerId, toolUse.name, toolUse.input as Record<string, unknown>, phone);
          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          };
        } catch (err) {
          // Without this, a tool failure (e.g. extract_email_attachment's download or
          // extraction step throwing) is invisible server-side — only the model sees a bare
          // error string, and the user only sees whatever the model paraphrases it as.
          console.error(`assistant: tool "${toolUse.name}" threw`, err);
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

  return finish({ text: "I wasn't able to finish that within my tool-call limit — try a more specific request." });
}

// Narrow, tool-free assistant call used by the WhatsApp registration state machine
// (whatsappRegistration.ts) when a reply doesn't match what a rigid step expects (not a valid
// email, not "resend"). It only converses — it has no tools and no authority over whether an
// email is ultimately accepted; that stays a hardcoded regex + isEmailInvited check in the
// caller, same "the model interprets, code decides" split the rest of the app uses.
const REGISTRATION_ASSIST_SYSTEM_PROMPTS: Record<"email" | "link" | "provider", string> = {
  email:
    "You are Marlowe, helping someone finish signing up for a personal WhatsApp assistant. " +
    "They're supposed to reply with the email address they use for Gmail or Outlook so it can " +
    "be connected. Respond briefly — one or two short sentences, plain language, suited to " +
    "someone who isn't very tech-savvy — to what they said, then end by asking again for their " +
    "email address. You have no authority over whether an email address is valid or accepted — " +
    "never claim it is or isn't, that's decided elsewhere. If they say they have more than one " +
    "email, tell them any address works and they can connect others later.",
  link:
    "You are Marlowe, helping someone finish signing up for a personal WhatsApp assistant. A " +
    "one-time link to connect their Gmail/Outlook was already sent to them and they're supposed " +
    "to tap it. Respond briefly — one or two short sentences, plain language — to what they " +
    "said, then remind them to tap the link above, or reply \"resend\" if it expired.",
  provider:
    "You are Marlowe, helping someone finish signing up for a personal WhatsApp assistant. " +
    "They were just shown two tappable buttons asking whether they use Gmail or Outlook/Hotmail, " +
    "but typed a reply instead of tapping one. Respond briefly — one or two short sentences, " +
    "plain language — to what they said, then ask them to tap Gmail or Outlook above (or say " +
    "which one they use).",
};

const REGISTRATION_ASSIST_FALLBACK: Record<"email" | "link" | "provider", string> = {
  email: "Sorry, what's the email address you'd like to use?",
  link: "Tap the link above to connect your email, or reply \"resend\" if it expired.",
  provider: "Do you use Gmail or Outlook/Hotmail? Tap one of the buttons above, or just tell me which.",
};

// Tool-free assistant call for the public marketing site's help widget (helpChatRoutes.ts).
// Unlike getRegistrationAssistReply below, this one carries real multi-turn history since it's a
// standalone conversation, not a single interruption of a rigid state machine. It only ever talks
// about the product in general terms — it has no tools, no database access, and no way to look up
// any real user's account, so it must say so rather than imply otherwise if asked anything
// account-specific.
export interface HelpChatTurn {
  role: "user" | "assistant";
  text: string;
}

const HELP_CHAT_SYSTEM_PROMPT =
  "You are Marlowe, answering questions on Marlowe's public marketing website for a visitor " +
  "who has not signed in. Marlowe is a personal AI assistant that connects to someone's Gmail " +
  "or Outlook, calendar, Google Drive or OneDrive, and Microsoft Teams, plus a dedicated " +
  "WhatsApp number — one conversation instead of switching between apps. It gives a daily " +
  "briefing, answers questions about mail/calendar/files, drafts email replies (it never sends " +
  "mail as the user — drafts always wait in their own mailbox for them to send), helps move " +
  "meetings, and files forwarded documents like boarding passes or receipts, including tracking " +
  "Schengen 90/180-day limits automatically from tickets already forwarded. Sign-in is with a " +
  "Google or Microsoft account, no separate password. Marlowe is currently in a closed preview — " +
  "only invited email addresses can sign in. " +
  "Answer briefly and helpfully, in plain language, and nudge toward signing in with Google or " +
  "Microsoft when it's a natural next step. You have no access to any real user's account, " +
  "inbox, or data from this widget — if asked anything account-specific (\"what's in my inbox\", " +
  "\"did my trip get logged\", etc.), say plainly that you can't see their account from here and " +
  "that they should sign in and ask there instead. Never claim to take an action (you cannot " +
  "send anything from this chat). If asked something you don't know, say so rather than " +
  "guessing, and suggest hello@marlowe.app.";

const HELP_CHAT_FALLBACK =
  "Sorry, I'm having trouble answering right now — try again in a moment, or email hello@marlowe.app.";

export async function getHelpChatReply(history: HelpChatTurn[]): Promise<string> {
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: MODEL_SIMPLE,
      max_tokens: 300,
      system: HELP_CHAT_SYSTEM_PROMPT,
      messages: history.map((turn) => ({ role: turn.role, content: turn.text })),
    });
    // No owner yet — this is the public marketing site, pre-sign-in.
    recordApiUsage(
      null,
      "web",
      MODEL_SIMPLE,
      "help_widget",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return text?.text ?? HELP_CHAT_FALLBACK;
  } catch (err) {
    console.error("help chat reply failed", err);
    return HELP_CHAT_FALLBACK;
  }
}

export async function getRegistrationAssistReply(
  userText: string,
  context: "email" | "link" | "provider"
): Promise<string> {
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.create({
      model: MODEL_SIMPLE,
      max_tokens: 200,
      system: REGISTRATION_ASSIST_SYSTEM_PROMPTS[context],
      messages: [{ role: "user", content: userText }],
    });
    // No owner yet — this fires mid-signup, before a users row exists for this phone number.
    recordApiUsage(
      null,
      "whatsapp",
      MODEL_SIMPLE,
      "registration_assist",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return text?.text ?? REGISTRATION_ASSIST_FALLBACK[context];
  } catch (err) {
    console.error("registration assist reply failed", err);
    return REGISTRATION_ASSIST_FALLBACK[context];
  }
}
