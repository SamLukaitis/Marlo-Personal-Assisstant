// What Joyce sends back for one inbound message: one or more WhatsApp messages, in order. Most
// replies are a single message, but scripted ones are deliberately split — the introduction is
// four short messages, and a family ID always goes out on its own so it can be long-pressed and
// copied without picking up the sentence around it.

export interface JoyceButton {
  /** Comes back on a tap, but Joyce reads the tapped button's title instead — see extractJoyceMessages. */
  id: string;
  /** WhatsApp caps reply-button titles at 20 characters. */
  title: string;
}

export interface JoyceMessage {
  text: string;
  /** Up to three tappable reply buttons under the text. */
  buttons?: JoyceButton[];
}

/** Each string becomes its own message. */
export function messages(...texts: string[]): JoyceMessage[] {
  return texts.map((text) => ({ text }));
}

/** The text of every message, joined the way it would read on the phone — for history and tests. */
export function asText(reply: JoyceMessage[]): string {
  return reply.map((m) => m.text).join("\n\n");
}
