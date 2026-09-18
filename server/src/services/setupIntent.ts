// Decides whether a reply to postConnectSetup.ts's ask_first_task question ("anything you'd like
// me to look at right now, or shall we finish setting up?") means "carry on with setup" or is a
// real request. An exact-match skip list alone missed natural phrasings like "Let's just set up",
// which were then forwarded to the assistant as if they were a request — and the assistant, with
// nothing real to do, improvised a reply from stale conversation history (a user's own report: it
// told them a Gmail connection issue had been "flagged for the team" right after connecting fine).
import Anthropic from "@anthropic-ai/sdk";
import { recordApiUsage } from "../db/store.js";

// Unambiguous "move on" replies — answered without a model call. Whole-message match, so a real
// request that happens to contain one of these words isn't misread.
const CONTINUE_PATTERN =
  /^(skip|no|nope|no thanks|nothing|none|all good|i'?m good|not now|not right now|let'?s continue|continue|carry on|next|finish setup|let'?s (just )?(finish )?(set ?up|setup)|just (set ?up|setup))[.!]*$/i;

const INTENT_MODEL = process.env.ASSISTANT_MODEL_SIMPLE ?? "claude-haiku-4-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function isObviousContinue(text: string): boolean {
  return CONTINUE_PATTERN.test(text.trim());
}

// On any model failure this falls back to treating the reply as a request — the pre-existing
// behavior, where the assistant still answers something rather than the reply being dropped.
export async function wantsToContinueSetup(ownerId: number, text: string): Promise<boolean> {
  if (isObviousContinue(text)) return true;
  try {
    const response = await getClient().messages.create({
      model: INTENT_MODEL,
      max_tokens: 5,
      messages: [
        {
          role: "user",
          content:
            "A new user just connected their email to an assistant during setup and was asked: " +
            "\"Anything you'd like me to look at right now, or shall we finish setting up?\"\n\n" +
            `Their reply: """${text}"""\n\n` +
            "Does the reply ask the assistant to actually do or look at something (REQUEST), or " +
            "does it just mean carry on / finish setting up / nothing right now (CONTINUE)? " +
            "Reply with exactly one word: REQUEST or CONTINUE.",
        },
      ],
    });
    recordApiUsage(
      ownerId,
      "background",
      INTENT_MODEL,
      "setup_intent_check",
      response.usage?.input_tokens ?? 0,
      response.usage?.output_tokens ?? 0,
      response.usage?.cache_read_input_tokens ?? 0,
      response.usage?.cache_creation_input_tokens ?? 0
    );
    const answer = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    return answer.toUpperCase().includes("CONTINUE");
  } catch (err) {
    console.error(`setupIntent: intent check failed for owner ${ownerId}`, err);
    return false;
  }
}
