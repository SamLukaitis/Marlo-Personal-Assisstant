// A WhatsApp reply carrying one phone-action link is sent as a "Run on iPhone" button instead of a
// bare URL: same number of taps, but it reads as an action rather than a link to inspect. Pure, and
// kept apart from phoneActions.ts so whatsappReply.ts doesn't pull in the store and follow-ups.
// See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
import { SERVER_URL } from "../config.js";

export const RUN_BUTTON_LABEL = "Run on iPhone";
// WhatsApp's limit for an interactive message body.
const MAX_BODY = 1024;
const DEFAULT_BODY = "Tap to run this on your iPhone.";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function actionButtonFor(text: string): { body: string; url: string } | null {
  const links = text.match(new RegExp(`${escapeRegExp(SERVER_URL)}/a/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])`, "g")) ?? [];
  // Two links in one reply need two buttons, which WhatsApp can't do in one message: keep them as text.
  if (links.length !== 1) return null;
  const url = links[0];
  const body =
    text
      .replace(url, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() || DEFAULT_BODY;
  return body.length > MAX_BODY ? null : { body, url };
}
