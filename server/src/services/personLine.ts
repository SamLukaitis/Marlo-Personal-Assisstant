import { senderDisplayName } from "./hub.js";
import { tidySnippet } from "./htmlToText.js";
import type { TriageGist } from "./realPersonTriage.js";

// One line per person who emailed: bold name, then what they want. Shared by instant pings
// (alerts.ts) and the evening digest (emailDigest.ts) so both read the same.
export function personLine(
  from: string,
  subject: string,
  gist?: Pick<TriageGist, "gist" | "needsReply">
): string {
  const name = senderDisplayName(from);
  if (gist?.gist) return `*${name}* — ${gist.gist}${gist.needsReply ? "; needs a reply" : ""}`;
  return `*${name}* emailed: "${tidySnippet(subject)}"`;
}
