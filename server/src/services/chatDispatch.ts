// handleText (and its link-saving helper, handleLink) used to live in whatsappRoutes.ts. Moved
// here so postConnectSetup.ts's blocking free-text setup steps (ask_first_task,
// ask_briefing_content — see docs/superpowers/specs/2026-08-28-whatsapp-onboarding-redesign-design.md)
// can route a real request straight through ordinary chat handling without whatsappRoutes.ts and
// postConnectSetup.ts importing each other.
import {
  getWhatsAppHistory,
  appendWhatsAppMessage,
} from "../db/store.js";
import { runAssistantChat, MAX_HISTORY_MESSAGES } from "../ai/assistant.js";
import { ingestWhatsAppLink } from "./documents.js";
import { findSaveableUrl, type FetchFailureReason } from "./safeLinkFetcher.js";
import { isHelpTrigger, MARLOWE_HELP_TEXT } from "./whatsappRegistration.js";
import { sendAssistantReply } from "./whatsappReply.js";
import { isVersionTrigger, buildVersionText } from "./version.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";

// Friendly, non-leaky wording per failure reason — never expose the raw fetch/DNS error detail
// to the end user, just enough for them to know what to do next.
function linkFailureMessage(reason: FetchFailureReason): string {
  switch (reason) {
    case "invalid_url":
    case "unsupported_scheme":
      return "That doesn't look like a regular web link I can open — send me a normal http/https address.";
    case "blocked_host":
    case "dns_error":
      return "I couldn't reach that link — double check the address, or just tell me the details directly.";
    case "timeout":
      return "That page took too long to load, so I couldn't save it — you can try again or tell me the details directly.";
    case "too_many_redirects":
      return "That link redirected too many times for me to follow — try sending the direct page.";
    case "non_html_content":
      return "That link points to a file rather than a web page, so I can't read it directly — try sending the file itself.";
    case "response_too_large":
    case "network_error":
      return "I ran into a problem trying to open that link, so I couldn't save it.";
  }
}

async function handleLink(ownerId: number, from: string, url: string, messageId: string): Promise<void> {
  const result = await ingestWhatsAppLink({ ownerId, phone: from, url });

  if (!result.ok) {
    const reply = linkFailureMessage(result.reason);
    appendWhatsAppMessage(ownerId, from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // Same pattern as whatsappRoutes.ts's handleMedia: route through the normal assistant loop so
  // the saved page's content can actually be acted on/confirmed, not just echoed back.
  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const docContext =
    `[A link was just sent via WhatsApp, fetched, and saved — no need to save it again, just ` +
    `confirm and/or act on it. Extracted content:\n${result.doc.extractedText}`;
  if (history.length > 0) {
    history[history.length - 1] = { role: "user", content: docContext };
  } else {
    history.push({ role: "user", content: docContext });
  }

  const reply = await runAssistantChat(ownerId, history, from);
  await sendAssistantReply(ownerId, from, reply, messageId);
}

export async function handleText(
  ownerId: number,
  from: string,
  text: string,
  messageId: string
): Promise<void> {
  appendWhatsAppMessage(ownerId, from, "user", text);

  // "help"/"menu" short-circuits straight to the same canned overview used at first contact —
  // instant, free, and worded consistently regardless of how the model might otherwise phrase
  // "what can you do", instead of spending an assistant turn on it.
  if (isHelpTrigger(text)) {
    appendWhatsAppMessage(ownerId, from, "assistant", MARLOWE_HELP_TEXT);
    await sendWhatsAppMessage(from, MARLOWE_HELP_TEXT);
    return;
  }

  // Same short-circuit shape as help, above — bypasses the model entirely so it works (and
  // tells the truth) even if the assistant/tool layer itself is what's broken or stale.
  if (isVersionTrigger(text)) {
    const versionText = buildVersionText();
    appendWhatsAppMessage(ownerId, from, "assistant", versionText);
    await sendWhatsAppMessage(from, versionText);
    return;
  }

  // A message that's just a URL (with at most a short lead-in) is treated as "save this link"
  // the same way a photo/PDF attachment already gets saved — see
  // safeLinkFetcher.findSaveableUrl for the detection heuristic and why it's biased hard toward
  // precision over recall (a false positive costs a fetch + an LLM call and pollutes the
  // document store; a false negative just means the user re-sends the bare link).
  const url = findSaveableUrl(text);
  if (url) {
    await handleLink(ownerId, from, url, messageId);
    return;
  }

  const history = getWhatsAppHistory(from, MAX_HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const reply = await runAssistantChat(ownerId, history, from);
  await sendAssistantReply(ownerId, from, reply, messageId);
}
