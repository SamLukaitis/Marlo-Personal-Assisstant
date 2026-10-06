import { hubListNewMessages, isAutomatedMail } from "./hub.js";
import { hasAlerted, markAlerted, getSetting, setSetting, listPhoneNumbersForUser, listEntities } from "../db/store.js";
import { triageRealPersonEmails, type TriageGist } from "./realPersonTriage.js";
import { IMPORTANT_EMAIL_ENTITY_TYPE, type ImportantEmailEntityData } from "./importantEmailAlerts.js";
import { isWhatsAppConfigured } from "../providers/whatsapp.js";
import { realPersonAlertMode, realPersonAlertsEnabledSince } from "./emailAlertSettings.js";
import { queueForEmailDigest } from "./emailDigest.js";
import { isOnboardingSuppressionActive } from "./onboardingAlertSuppression.js";
import { submitAttentionItem } from "./attention.js";
import { personLine } from "./personLine.js";
import type { UnifiedMessage } from "../providers/types.js";

const MAX_ALERTS_PER_CHECK = 5;
const BASELINE_KEY = "alerts_baseline_set";

function messageKey(m: UnifiedMessage): string {
  return `${m.accountId}:${m.id}`;
}


// Polls for new mail from real people (not newsletters/notifications). By default each goes into
// the evening digest (emailDigest.ts) with a gist of what they want; users who chose instant mode
// get one concrete line per email through the attention gate. Dedupes via a persisted ledger so
// the same message never triggers twice across restarts. Runs per-tenant — scheduler.ts loops over
// every user and calls this once per owner.
export async function checkForNewImportantMessages(ownerId: number): Promise<void> {
  const messages = await hubListNewMessages(ownerId);
  // One line per scan that saw any mail, naming the gate that decided its fate — "I emailed it and
  // got no alert" was undiagnosable while every gate below dropped mail without a trace. Counts
  // only, never subject/sender/snippet. Silent when nothing was fetched (the common quiet tick).
  const logScan = (outcome: string, unseen = 0): void => {
    if (messages.length === 0) return;
    console.log(
      `alerts: owner ${ownerId} ${outcome} (fetched ${messages.length}, real-person ${candidates.length}, unseen ${unseen})`
    );
  };
  // Deliberately NOT gated on m.unread — a user who opens a real person's message the moment it
  // arrives (completely normal) must not lose the alert. hasAlerted's per-message ledger below is
  // the real "have we already handled this" check, independent of whether the user has read it;
  // unread was a redundant, strictly worse substitute that silently and permanently dropped any
  // message read before this scan ever saw it.
  const candidates = messages.filter((m) => m.from && !isAutomatedMail(m));

  // First-ever run: record the current inbox as a baseline instead of alerting on everything
  // that was already sitting there unread before this feature existed.
  if (getSetting(ownerId, BASELINE_KEY) !== "true") {
    // Only mail from before the user switched alerts on is "already sitting there" — mail that
    // arrived after it (turning alerts on and immediately testing them) must fall through and
    // alert, not get swallowed as backlog. No timestamp (never switched on from off) baselines
    // everything, as before.
    const enabledAt = realPersonAlertsEnabledSince(ownerId);
    let baselined = 0;
    for (const m of candidates) {
      if (enabledAt === 0 || new Date(m.receivedAt).getTime() < enabledAt) {
        markAlerted(ownerId, messageKey(m));
        baselined++;
      }
    }
    setSetting(ownerId, BASELINE_KEY, "true");
    logScan(`first scan: baselined ${baselined} as existing mail`);
  }

  const unseen = candidates.filter((m) => !hasAlerted(ownerId, messageKey(m)));
  if (unseen.length === 0) {
    if (candidates.length === 0) logScan("no real-person mail (all automated or no sender)");
    else logScan("nothing new (already handled)");
    return;
  }
  if (!isWhatsAppConfigured()) {
    logScan("skipped: WhatsApp is not configured", unseen.length);
    return;
  }

  const numbers = listPhoneNumbersForUser(ownerId).map((r) => r.phone);
  if (numbers.length === 0) {
    logScan("skipped: no registered phone number", unseen.length);
    return;
  }

  const { skipped, gists } = await triageUnseen(ownerId, unseen);
  for (const m of unseen) if (skipped.has(m)) markAlerted(ownerId, messageKey(m));
  const toAlert = unseen.filter((m) => !skipped.has(m));
  if (toAlert.length === 0) {
    logScan(`skipped ${skipped.size} (marketing or repeats an earlier alert)`, unseen.length);
    return;
  }
  const withGists = (ms: UnifiedMessage[]) =>
    ms.map((m) => ({ ...m, gist: gists.get(m)?.gist, needsReply: gists.get(m)?.needsReply }));

  // Digest mode, or mid-onboarding (never interleave pings with the setup questions): hold for
  // emailDigest.ts's once-a-day summary. Marked alerted at once so nothing is queued twice.
  const onboarding = isOnboardingSuppressionActive(ownerId);
  if (onboarding || realPersonAlertMode(ownerId) === "digest") {
    queueForEmailDigest(ownerId, withGists(toAlert));
    for (const m of toAlert) markAlerted(ownerId, messageKey(m));
    logScan(
      `${onboarding ? "onboarding: " : ""}queued ${toAlert.length} for the digest${skipped.size ? `, skipped ${skipped.size}` : ""}`,
      unseen.length
    );
    return;
  }

  // Instant mode: each goes through the attention gate (quiet hours apply; cap-exempt, since the
  // user asked for every email). Past the per-check limit, the rest wait for the digest.
  const toSend = toAlert.slice(0, MAX_ALERTS_PER_CHECK);
  for (const m of toSend) {
    await submitAttentionItem(ownerId, {
      source: "email",
      category: "person_email",
      details: {
        summary: personLine(m.from, m.subject, gists.get(m)),
        accountId: m.accountId,
        messageId: m.id,
        emailSubject: m.subject,
        emailFrom: m.from,
      },
      fallbackKey: `person:${m.accountId}:${m.id}`,
    });
    markAlerted(ownerId, messageKey(m));
  }
  const rest = toAlert.slice(MAX_ALERTS_PER_CHECK);
  if (rest.length > 0) {
    queueForEmailDigest(ownerId, withGists(rest));
    for (const m of rest) markAlerted(ownerId, messageKey(m));
  }
  logScan(
    `sent ${toSend.length}${rest.length ? `, ${rest.length} to the digest` : ""}` +
      (skipped.size ? `, skipped ${skipped.size}` : ""),
    unseen.length
  );
}

const RECENT_ALERT_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_RECENT_ALERTS = 15;

// Which of `unseen` should not alert (see realPersonTriage.ts), plus a gist of what each kept one
// is about. Fails open: if the model call breaks, every message alerts as it did before the triage
// existed, just without a gist. Runs after the deliverability gates so it is only paid for when an
// alert or digest entry is actually about to happen.
async function triageUnseen(
  ownerId: number,
  unseen: UnifiedMessage[]
): Promise<{ skipped: Set<UnifiedMessage>; gists: Map<UnifiedMessage, TriageGist> }> {
  const skipped = new Set<UnifiedMessage>();
  const gists = new Map<UnifiedMessage, TriageGist>();
  const since = Date.now() - RECENT_ALERT_WINDOW_MS;
  const recentAlerts = listEntities<ImportantEmailEntityData>(ownerId, { type: IMPORTANT_EMAIL_ENTITY_TYPE })
    .filter((e) => e.createdAt >= since)
    .slice(0, MAX_RECENT_ALERTS)
    .map((e) => e.data.summary);
  try {
    const verdicts = await triageRealPersonEmails(
      unseen.map((m, index) => ({ index, from: m.from, subject: m.subject, snippet: m.snippet })),
      recentAlerts,
      ownerId
    );
    for (const index of verdicts.skips.keys()) if (unseen[index]) skipped.add(unseen[index]);
    for (const [index, gist] of verdicts.gists) if (unseen[index]) gists.set(unseen[index], gist);
  } catch (err) {
    console.error(`alerts: triage failed for owner ${ownerId}, alerting on everything`, err);
  }
  return { skipped, gists };
}
