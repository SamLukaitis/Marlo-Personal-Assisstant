// Consumes a tap on a pending-actions message (see ai/assistant.ts's ask_user_choice /
// db/store.ts's pending_actions table). Called from whatsappRoutes.ts's handleIncoming right
// after the post-connect-setup check, with the same contract: returns false to fall through to
// normal handling for anything that isn't one of these taps.
import { consumePendingAction, appendWhatsAppMessage, getWhatsAppHistory } from "../db/store.js";
import { runTool, runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";
import { sendAssistantReply } from "./whatsappReply.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const EXPIRED_REPLY = "That option has expired — just ask me again.";

// Friendly per-tool confirmation text for a zero-LLM confirm execution — falls back to a generic
// "done" for any tool without a specific entry here.
const CONFIRM_RESULT_LABEL: Record<string, (result: unknown) => string> = {
  archive_messages: (result) => {
    const archived = (result as { archived?: number } | undefined)?.archived;
    return typeof archived === "number"
      ? `✓ Archived ${archived} message${archived === 1 ? "" : "s"}.`
      : "✓ Done.";
  },
  delete_calendar_event: () => "✓ Deleted.",
};

function describeToolResult(tool: string, result: unknown): string {
  const describe = CONFIRM_RESULT_LABEL[tool];
  return describe ? describe(result) : "✓ Done.";
}

// A pending-action tap id is `pa:<uuid>:<key>` — see ai/assistant.ts's buildChoiceReply, which
// generates these. Anything else (e.g. postConnectSetup.ts's plain "briefing_yes"-style ids)
// doesn't match and falls through.
function parseTapId(buttonId: string): { actionId: string; key: string } | null {
  const match = /^pa:([^:]+):(.+)$/.exec(buttonId);
  if (!match) return null;
  return { actionId: match[1], key: match[2] };
}

export async function handlePendingActionReply(
  ownerId: number,
  message: IncomingWhatsAppMessage
): Promise<boolean> {
  if (message.kind !== "interactive") return false;
  const parsed = parseTapId(message.buttonId);
  if (!parsed) return false;

  const phone = message.from;
  const action = consumePendingAction(parsed.actionId, ownerId);
  if (!action) {
    await sendWhatsAppMessage(phone, EXPIRED_REPLY);
    return true;
  }

  if (action.mode === "confirm") {
    if (parsed.key !== "yes") {
      appendWhatsAppMessage(ownerId, phone, "assistant", "Cancelled.");
      await sendWhatsAppMessage(phone, "Cancelled.");
      return true;
    }
    const { tool, input } = JSON.parse(action.contextJson) as {
      tool: string;
      input: Record<string, unknown>;
    };
    try {
      const result = await runTool(ownerId, tool, input);
      const confirmText = describeToolResult(tool, result);
      appendWhatsAppMessage(ownerId, phone, "assistant", confirmText);
      await sendWhatsAppMessage(phone, confirmText);
    } catch (err) {
      console.error("actionHandlers: confirmed tool call failed", err);
      await sendWhatsAppMessage(
        phone,
        "Sorry, that didn't go through — check the server logs."
      ).catch(() => {});
    }
    return true;
  }

  // resume
  const { options } = JSON.parse(action.contextJson) as { options: string[] };
  const label = options[Number(parsed.key)];
  if (label === undefined) {
    await sendWhatsAppMessage(phone, EXPIRED_REPLY);
    return true;
  }
  appendWhatsAppMessage(ownerId, phone, "user", `(User selected: ${label})`);
  const history = getWhatsAppHistory(phone, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const reply = await runAssistantChat(ownerId, history);
  await sendAssistantReply(ownerId, phone, reply);
  return true;
}
