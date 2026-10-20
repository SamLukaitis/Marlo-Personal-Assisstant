// A flight or hotel reply on WhatsApp ends with one "View Google Flights" / "View Google Hotels"
// button for the whole search, instead of the search link typed out at the bottom. The
// per-option links (Kiwi.com, Booking.com, a hotel's site) stay in the text: a WhatsApp button
// message carries only one button. Pure, like phoneActionButton.ts, so whatsappReply.ts can use it
// without pulling in the assistant.
//
// runAssistantChat (ai/assistant.ts) attaches the button to the reply only when exactly one
// search link from this reply's searches appears in the text (comparing two dates gives two links,
// and those stay as text).

// WhatsApp's limits: 20 characters on the button, 1024 on an interactive message body.
const MAX_LABEL = 20;
const MAX_BODY = 1024;
// What's left of a link's line once the URL is taken out, for it to count as just a label
// ("All options:", "Google Flights:") rather than a sentence that would lose its meaning.
const MAX_LEFTOVER_LABEL = 40;
export const DEFAULT_LINK_BUTTON_BODY = "Every option, with prices from each airline or booking site.";

export interface LinkButton {
  label: string;
  url: string;
}

export const SEARCH_BUTTON_LABELS: Record<"googleFlightsUrl" | "googleHotelsUrl", string> = {
  googleFlightsUrl: "View Google Flights",
  googleHotelsUrl: "View Google Hotels",
};

// The text to send with the button: the reply minus the line(s) carrying the button's URL. Null
// when the URL sits inside a sentence, so taking it out would leave the sentence broken.
export function textWithoutButtonLink(text: string, button: LinkButton): string | null {
  if (button.label.length > MAX_LABEL || !text.includes(button.url)) return null;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(button.url)) {
      kept.push(line);
      continue;
    }
    const leftover = line.split(button.url).join("").trim();
    if (leftover.length > MAX_LEFTOVER_LABEL) return null;
  }
  return kept
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// How to send it: one message with the button under the reply, or, when the reply is too long
// for an interactive message, the reply as normal text followed by a short message with the button.
export function planLinkButton(
  text: string,
  button: LinkButton
): { leadingText: string | null; body: string } | null {
  const body = textWithoutButtonLink(text, button);
  if (body === null) return null;
  if (!body) return { leadingText: null, body: DEFAULT_LINK_BUTTON_BODY };
  return body.length <= MAX_BODY ? { leadingText: null, body } : { leadingText: body, body: DEFAULT_LINK_BUTTON_BODY };
}
