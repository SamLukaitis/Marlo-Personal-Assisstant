// Unsubscribes the user from a mailing list using the message's own List-Unsubscribe headers.
// Order of preference: RFC 8058 one-click POST, then the mailto: target, then just handing the
// user the link — a plain link is never fetched automatically (GET-based unsubscribes are unsafe
// and usually land on a confirmation page a human has to finish).
import { hubGetUnsubscribeInfo, hubSendMessage } from "./hub.js";
import { safePostOneClick } from "./safeLinkFetcher.js";

export interface MailtoTarget {
  to: string;
  subject: string;
  body: string;
}

export interface UnsubscribeTargets {
  url?: string;
  mailto?: MailtoTarget;
  oneClick: boolean;
}

export type UnsubscribeOutcome =
  | { status: "unsubscribed"; method: "one_click" | "mailto"; sender: string }
  | { status: "manual_link"; url: string; sender: string }
  | { status: "unavailable"; reason: string };

const PLAIN_EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function parseMailto(raw: string): MailtoTarget | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  let to: string;
  try {
    to = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  if (!PLAIN_EMAIL.test(to)) return undefined;
  // subject/body are sender-controlled and end up in a message sent from the user's account —
  // strip line breaks (header injection) and cap the length.
  const subject = (u.searchParams.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const body = (u.searchParams.get("body") ?? "").slice(0, 1000);
  return { to, subject: subject || "unsubscribe", body };
}

export function parseUnsubscribeHeaders(listUnsubscribe: string, listUnsubscribePost: string): UnsubscribeTargets {
  const items = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const httpsUrl = items.find((i) => /^https:\/\//i.test(i));
  const httpUrl = items.find((i) => /^http:\/\//i.test(i));
  const mailtoRaw = items.find((i) => /^mailto:/i.test(i));

  const url = httpsUrl ?? httpUrl;
  const mailto = mailtoRaw ? parseMailto(mailtoRaw) : undefined;
  const oneClick = !!httpsUrl && /list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost);
  return { ...(url ? { url } : {}), ...(mailto ? { mailto } : {}), oneClick };
}

export async function unsubscribeFromMessage(
  ownerId: number,
  accountId: number,
  messageId: string
): Promise<UnsubscribeOutcome> {
  const info = await hubGetUnsubscribeInfo(ownerId, accountId, messageId);
  if (!info) return { status: "unavailable", reason: "I couldn't find that message." };

  const targets = parseUnsubscribeHeaders(info.listUnsubscribe, info.listUnsubscribePost);
  if (!targets.url && !targets.mailto) {
    return {
      status: "unavailable",
      reason: "This sender didn't include an unsubscribe option in the email, so it can't be done automatically.",
    };
  }

  if (targets.oneClick && targets.url) {
    const posted = await safePostOneClick(targets.url);
    if (posted.ok) return { status: "unsubscribed", method: "one_click", sender: info.from };
  }

  let mailtoError: string | undefined;
  if (targets.mailto) {
    try {
      await hubSendMessage(ownerId, accountId, targets.mailto.to, targets.mailto.subject, targets.mailto.body);
      return { status: "unsubscribed", method: "mailto", sender: info.from };
    } catch (err) {
      mailtoError = err instanceof Error ? err.message : String(err);
    }
  }

  if (targets.url) return { status: "manual_link", url: targets.url, sender: info.from };
  return { status: "unavailable", reason: mailtoError ?? "The unsubscribe request couldn't be sent." };
}
