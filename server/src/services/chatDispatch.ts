// handleText (and its link-saving helper, handleLink) used to live in whatsappRoutes.ts. Moved
// here so postConnectSetup.ts's blocking free-text setup steps (ask_first_task,
// ask_briefing_content — see docs/superpowers/specs/2026-08-28-whatsapp-onboarding-redesign-design.md)
// can route a real request straight through ordinary chat handling without whatsappRoutes.ts and
// postConnectSetup.ts importing each other.
import { appendWhatsAppMessage } from "../db/store.js";
import { ingestWhatsAppLink } from "./documents.js";
import { findSaveableUrl, type FetchFailureReason } from "./safeLinkFetcher.js";
import { isHelpTrigger, MARLOWE_HELP_TEXT } from "./whatsappRegistration.js";
import { isVersionTrigger, buildVersionText } from "./version.js";
import { sendWhatsAppMessage } from "../providers/whatsapp.js";
import { resolveQuotedMessageContext } from "./quotedMessage.js";
import { queueForAssistant, looksComplete } from "./messageBatching.js";

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

async function handleLink(
  ownerId: number,
  from: string,
  url: string,
  messageId: string,
  historyRowId: number
): Promise<void> {
  const result = await ingestWhatsAppLink({ ownerId, phone: from, url });

  if (!result.ok) {
    const reply = linkFailureMessage(result.reason);
    appendWhatsAppMessage(ownerId, from, "assistant", reply);
    await sendWhatsAppMessage(from, reply);
    return;
  }

  // Same pattern as whatsappRoutes.ts's handleMedia: route through the normal assistant loop (via
  // the batching queue, so a message sent right after this one still gets folded into the same
  // reply) so the saved page's content can actually be acted on/confirmed, not just echoed back.
  const docContext =
    `[A link was just sent via WhatsApp, fetched, and saved — no need to save it again, just ` +
    `confirm and/or act on it. Extracted content:\n${result.doc.extractedText}`;
  // No caption to judge completeness from — same default as an uncaptioned media attachment,
  // biased toward waiting since a bare link is often followed by an explanatory message.
  queueForAssistant(ownerId, from, messageId, historyRowId, docContext, false);
}

// Folds a dropped WhatsApp pin into the conversation the same way handleLink folds in a saved
// page — except the content here is always just a couple of numbers (and maybe a name/address),
// so unlike handleLink/handleMedia's docContext there's no need to persist a short placeholder
// and swap in a longer version just for the model: the full location line is short enough to
// store as-is and reuse for both.
export async function handleLocation(
  ownerId: number,
  from: string,
  latitude: number,
  longitude: number,
  messageId: string,
  name?: string,
  address?: string
): Promise<void> {
  const label = name ? `${name}${address ? `, ${address}` : ""}` : undefined;
  const locationText = `[User shared their location: ${latitude}, ${longitude}${label ? ` (${label})` : ""}]`;
  const rowId = appendWhatsAppMessage(ownerId, from, "user", locationText);

  // The persisted line is already exactly what the model should see, so no override — a dropped
  // pin is rarely followed by more, so it takes the short debounce path like a complete message.
  queueForAssistant(ownerId, from, messageId, rowId, null, true);
}

export async function handleText(
  ownerId: number,
  from: string,
  text: string,
  messageId: string,
  quotedMessageId?: string,
  forwarded?: boolean
): Promise<void> {
  const rowId = appendWhatsAppMessage(ownerId, from, "user", text);

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
    await handleLink(ownerId, from, url, messageId, rowId);
    return;
  }

  // Same pattern as handleLink/handleMedia's docContext: override the persisted history line with
  // the real resolved content at flush time so the model answers from what the swipe-reply
  // actually pointed at instead of guessing — see quotedMessage.ts.
  const quotedContext = resolveQuotedMessageContext(ownerId, quotedMessageId, forwarded);
  const override = quotedContext ? `${quotedContext}\n\n${text}` : null;
  queueForAssistant(ownerId, from, messageId, rowId, override, looksComplete(text));
}
