// Consumes a tap on a pending-actions message (see ai/assistant.ts's ask_user_choice /
// db/store.ts's pending_actions table). Called from whatsappRoutes.ts's handleIncoming right
// after the post-connect-setup check, with the same contract: returns false to fall through to
// normal handling for anything that isn't one of these taps.
import {
  consumePendingAction,
  consumePendingActionsByMode,
  createPendingAction,
  appendWhatsAppMessage,
  getWhatsAppHistory,
} from "../db/store.js";
import { emailDigestTime, formatDigestTime, setRealPersonAlertMode } from "./emailAlertSettings.js";
import { runTool, runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { sendWhatsAppMessage, sendChoiceMessage } from "../providers/whatsapp.js";
import { hubHasSentTo } from "./hub.js";
import { sendAssistantReply } from "./whatsappReply.js";
import { sendConnectLink } from "./connectMailboxLink.js";
import type { IncomingWhatsAppMessage } from "../providers/whatsapp.js";

const EXPIRED_REPLY = "That option has expired — just ask me again.";

// Matched by name, not instanceof, so it survives the provider module being mocked in tests.
function isOutlookSendPermissionError(err: unknown): err is { accountEmail: string } {
  return err instanceof Error && err.name === "OutlookSendPermissionError";
}

// The Send tap hit an Outlook mailbox connected before Mail.Send was requested. This is the one
// moment the reconnect is worth asking for — the user is trying to send right now — so the email
// is kept safe in their Drafts (Mail.ReadWrite, which they did grant) and the reconnect link
// follows. Recorded in the chat history so a later "send it" has the context to go again.
async function handleOutlookSendPermission(
  ownerId: number,
  phone: string,
  input: Record<string, unknown>,
  accountEmail: string
): Promise<void> {
  let savedDraft = false;
  try {
    await runTool(ownerId, "create_email_draft", input, phone);
    savedDraft = true;
  } catch (err) {
    console.error("actionHandlers: couldn't save the unsent Outlook email as a draft", err);
  }
  const text =
    `I couldn't send that yet — ${accountEmail} was connected before I could send from Outlook, ` +
    `so it needs one quick reconnect.` +
    (savedDraft ? " I've saved your email in your Outlook Drafts in the meantime." : "") +
    " Once you've reconnected, just tell me to send it.";
  appendWhatsAppMessage(ownerId, phone, "assistant", text);
  await sendWhatsAppMessage(phone, text).catch(() => {});
  await sendConnectLink(phone, "microsoft", "enable_send").catch((err) =>
    console.error("actionHandlers: couldn't send the Outlook reconnect link", err)
  );
}

interface ConfirmContext {
  tool: string;
  input: Record<string, unknown>;
  declineTool?: string;
  declineInput?: Record<string, unknown>;
  // Set on the second question asked by askAboutNewRecipient, so its Yes tap sends rather than
  // checking the recipient again.
  recipientChecked?: boolean;
}

// Looks in the sending mailbox's own Sent folder. A lookup failure counts as "not emailed
// before": the cost is one extra tap, whereas skipping the warning is the unsafe direction.
async function hasEmailedBefore(ownerId: number, accountId: number, to: string): Promise<boolean> {
  try {
    return await hubHasSentTo(ownerId, accountId, to);
  } catch (err) {
    console.error("actionHandlers: couldn't check the Sent folder for a previous email", err);
    return false;
  }
}

// Asked after the Send tap, before anything is sent, when the mailbox has never emailed this
// address. A wrong or look-alike address is exactly what a mistyped contact or a prompt-injected
// email would produce, and the user hasn't necessarily read the address closely the first time.
async function askAboutNewRecipient(ownerId: number, phone: string, to: string, context: ConfirmContext): Promise<void> {
  const text = `⚠️ Warning — you haven't emailed this person before. Are you sure ${to} is the correct email?`;
  const actionId = createPendingAction(
    ownerId,
    "confirm",
    text,
    JSON.stringify({ ...context, recipientChecked: true })
  );
  appendWhatsAppMessage(ownerId, phone, "assistant", text);
  await sendChoiceMessage(phone, text, [
    { id: `pa:${actionId}:yes`, title: "Yes, send" },
    {
      id: `pa:${actionId}:no`,
      title: context.declineTool === "create_email_draft" ? "No, keep as draft" : "No, don't send",
    },
  ]);
}

// Friendly per-tool confirmation text for a zero-LLM confirm execution — falls back to a generic
// "done" for any tool without a specific entry here.
const CONFIRM_RESULT_LABEL: Record<string, (result: unknown) => string> = {
  archive_messages: (result) => {
    const archived = (result as { archived?: number } | undefined)?.archived;
    return typeof archived === "number"
      ? `✓ Archived ${archived} message${archived === 1 ? "" : "s"}.`
      : "✓ Done.";
  },
  unsubscribe_from_sender: (result) => {
    const r = result as
      | { status?: string; method?: string; url?: string; sender?: string; reason?: string }
      | undefined;
    const sender = r?.sender ? ` from ${r.sender}` : "";
    if (r?.status === "unsubscribed") {
      return `✓ Unsubscribed${sender}. It can take a few days for the emails to stop.`;
    }
    if (r?.status === "manual_link" && r.url) {
      return `I couldn't unsubscribe${sender} automatically — tap this link to finish: ${r.url}`;
    }
    return r?.reason ?? "Sorry, I couldn't unsubscribe from that sender.";
  },
  delete_calendar_event: () => "✓ Deleted.",
  send_email: () => "✓ Sent.",
  undo_expense: (result) => {
    const deleted = (result as { deleted?: { vendor?: string; amountPence?: number; currency?: string } } | undefined)
      ?.deleted;
    if (!deleted) return "✓ Removed.";
    const amount =
      typeof deleted.amountPence === "number" && deleted.currency
        ? ` (${(deleted.amountPence / 100).toFixed(2)} ${deleted.currency})`
        : "";
    return `✓ Removed the expense${deleted.vendor ? ` for ${deleted.vendor}` : ""}${amount}.`;
  },
  create_email_draft: () => "📝 Saved as a draft — nothing was sent.",
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

// The three buttons under the first daily email summary (services/emailDigest.ts). Keep and Instant
// are answered directly with no model call; "Different time" needs a follow-up question, so it goes
// through the model like an Edit tap does — the digest's history note tells it to call
// set_email_alerts with the time.
async function handleEmailDigestTap(
  ownerId: number,
  phone: string,
  key: string,
  messageId: string
): Promise<boolean> {
  let reply: string;
  if (key === "keep") {
    setRealPersonAlertMode(ownerId, "digest");
    reply =
      `✓ Great, I'll keep sending one summary of people's emails each day at ` +
      `${formatDigestTime(emailDigestTime(ownerId))}. Just say "instant" any time if you'd rather be pinged for each one.`;
  } else if (key === "instant") {
    setRealPersonAlertMode(ownerId, "instant");
    reply = `✓ Done, I'll ping you as each email from a person arrives. Say "daily summary" any time to go back.`;
  } else if (key === "time") {
    appendWhatsAppMessage(ownerId, phone, "user", "(User wants a different time for the daily email summary.)");
    const history = getWhatsAppHistory(phone, MAX_HISTORY_MESSAGES).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const assistantReply = await runAssistantChat(ownerId, history, phone);
    await sendAssistantReply(ownerId, phone, assistantReply, messageId);
    return true;
  } else {
    await sendWhatsAppMessage(phone, EXPIRED_REPLY);
    return true;
  }
  appendWhatsAppMessage(ownerId, phone, "assistant", reply);
  await sendWhatsAppMessage(phone, reply);
  return true;
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

  if (action.mode === "email_digest") {
    // Whichever button was tapped, the question is answered: retire any other open copy of it (a
    // retried send, another of the user's numbers) so a stale tap can't undo this one.
    consumePendingActionsByMode(ownerId, "email_digest");
    return handleEmailDigestTap(ownerId, phone, parsed.key, message.messageId);
  }

  if (action.mode === "confirm") {
    const context = JSON.parse(action.contextJson) as ConfirmContext;
    const { tool, input, declineTool, declineInput } = context;

    // Edit isn't a yes/no outcome at all — nothing runs. Route the tap back through the model as
    // a normal follow-up, same pattern as a resume tap below, so it can ask what to change.
    if (parsed.key === "edit") {
      appendWhatsAppMessage(ownerId, phone, "user", "(User wants to edit this before continuing.)");
      const history = getWhatsAppHistory(phone, MAX_HISTORY_MESSAGES).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const reply = await runAssistantChat(ownerId, history, phone);
      await sendAssistantReply(ownerId, phone, reply, message.messageId);
      return true;
    }

    // No a tool/input to run on decline (the common case): just cancel, unchanged from before.
    // A decline_tool (e.g. create_email_draft when declining to send) runs instead, below.
    if (parsed.key !== "yes" && !declineTool) {
      appendWhatsAppMessage(ownerId, phone, "assistant", "Cancelled.");
      await sendWhatsAppMessage(phone, "Cancelled.");
      return true;
    }

    if (parsed.key === "yes" && tool === "send_email" && !context.recipientChecked) {
      const to = String(input.to ?? "");
      if (!(await hasEmailedBefore(ownerId, input.account_id as number, to))) {
        await askAboutNewRecipient(ownerId, phone, to, context);
        return true;
      }
    }

    const runTarget = parsed.key === "yes" ? tool : (declineTool as string);
    const runInput = parsed.key === "yes" ? input : (declineInput ?? {});
    try {
      const result = await runTool(ownerId, runTarget, runInput, phone);
      const confirmText = describeToolResult(runTarget, result);
      appendWhatsAppMessage(ownerId, phone, "assistant", confirmText);
      await sendWhatsAppMessage(phone, confirmText);
    } catch (err) {
      if (isOutlookSendPermissionError(err)) {
        await handleOutlookSendPermission(ownerId, phone, runInput, err.accountEmail);
        return true;
      }
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
  const reply = await runAssistantChat(ownerId, history, phone);
  await sendAssistantReply(ownerId, phone, reply, message.messageId);
  return true;
}
