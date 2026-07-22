import Anthropic from "@anthropic-ai/sdk";
import { listAccounts, getSetting } from "../db/store.js";
import {
  hubListMessages,
  hubGetMessage,
  hubListEvents,
  hubSearchFiles,
  hubCreateDraft,
} from "../services/hub.js";

const MODEL = process.env.ASSISTANT_MODEL ?? "claude-opus-4-8";

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
      "Search files in the user's connected Google Drive accounts by name or content. Call this when the user asks to find a document, invoice, spreadsheet, or other file.",
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
];

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
    case "create_email_draft":
      return hubCreateDraft(
        input.account_id as number,
        input.to as string,
        input.subject as string,
        input.body as string
      );
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

  return [
    `You are ${name}, a personal assistant that manages the user's connected accounts. Today's date is ${new Date().toDateString()}.`,
    persona ? `The user described how they want you to behave:\n${persona}` : "",
    `Connected accounts:\n${accountList}`,
    `Rules:
- Always look up real data with your tools before answering questions about email, calendar, or files — never invent contents.
- You can create email drafts but can never send email. After creating a draft, tell the user to review and send it from their mailbox.
- When several accounts are connected and the user's request is ambiguous about which one, search across all of them or ask.
- Keep answers concise and lead with the direct answer.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function runAssistantChat(history: ChatMessage[]): Promise<string> {
  const anthropic = getClient();
  const system = buildSystemPrompt();

  const messages: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let turn = 0; turn < 8; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system,
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
