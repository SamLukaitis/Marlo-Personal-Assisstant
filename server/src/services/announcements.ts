// Product-update announcements: an admin writes one in the Portal's Updates tab
// (routes/portalRoutes.ts) and it goes to every Marlo user's WhatsApp. Joyce families aren't
// included; she has her own number and her own users.
//
// WhatsApp only allows free-form text within 24h of the person's last message. Past that, the
// announcement goes out as the `marlowe_whats_new` template, which is approved as MARKETING —
// never as one of the utility templates alerts and briefings use, or Meta can pause those.
// Anyone can reply "stop updates" (handled in chatDispatch.ts) and won't get announcements again;
// alerts and briefings aren't affected.
import {
  getSetting,
  setSetting,
  listAllUserIds,
  listPhoneNumbersForUser,
  insertAnnouncement,
  getAnnouncement,
  setAnnouncementCounts,
  listProactiveDeliveryPhones,
  recordProactiveDelivery,
} from "../db/store.js";
import { isSimulatedPhone } from "../providers/whatsapp.js";
import { sendProactiveMessage } from "./outbound.js";

// The template's variable is capped at 1000 characters (outbound.ts); this leaves room for the
// opt-out line that's added after the admin's text.
export const MAX_ANNOUNCEMENT_CHARS = 900;

const OPT_OUT_SETTING = "product_updates";
const OPT_OUT_LINE = 'Reply "stop updates" if you\'d rather not get these.';
const FREE_FORM_HEADING = "*What's new in Marlo*";

const STOP_TRIGGERS = new Set(["stop updates", "stop update", "unsubscribe updates", "no more updates"]);
const START_TRIGGERS = new Set(["start updates", "resume updates"]);

export const STOPPED_REPLY =
  "Done. You won't get Marlo's update announcements any more. Your briefings and alerts are unchanged. Reply \"start updates\" to turn them back on.";
export const STARTED_REPLY = "Done. You'll get Marlo's update announcements again.";

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[.!]+$/, "");
}

// "stop updates" / "start updates" typed on their own, answered without the model, like "help".
export function updatesTrigger(text: string): "stop" | "start" | null {
  const t = normalise(text);
  if (STOP_TRIGGERS.has(t)) return "stop";
  if (START_TRIGGERS.has(t)) return "start";
  return null;
}

export function setProductUpdates(ownerId: number, on: boolean): void {
  setSetting(ownerId, OPT_OUT_SETTING, on ? "on" : "off");
}

export function wantsProductUpdates(ownerId: number): boolean {
  return getSetting(ownerId, OPT_OUT_SETTING) !== "off";
}

export interface AnnouncementRecipient {
  ownerId: number;
  phone: string;
}

export function listAnnouncementRecipients(): AnnouncementRecipient[] {
  const out: AnnouncementRecipient[] = [];
  for (const ownerId of listAllUserIds()) {
    if (!wantsProductUpdates(ownerId)) continue;
    for (const { phone } of listPhoneNumbersForUser(ownerId)) {
      // WhatsApp Simulator test users, not real people.
      if (!isSimulatedPhone(phone)) out.push({ ownerId, phone });
    }
  }
  return out;
}

export function validateAnnouncement(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw new Error("Write the update first.");
  if (text.length > MAX_ANNOUNCEMENT_CHARS) {
    throw new Error(`Keep it to ${MAX_ANNOUNCEMENT_CHARS} characters (it's ${text.length}).`);
  }
  return text;
}

async function sendOne(phone: string, text: string): Promise<void> {
  const freeForm = `${FREE_FORM_HEADING}\n\n${text}\n\n${OPT_OUT_LINE}`;
  // The template supplies its own "What's new in Marlo:" lead-in.
  await sendProactiveMessage(phone, freeForm, "announcement", undefined, `${text} ${OPT_OUT_LINE}`);
}

export interface SendCounts {
  sent: number;
  failed: number;
}

// To the admin's own numbers only, so they can see how it reads before everyone gets it. Sent
// even if they've turned announcements off, and not recorded as an announcement.
export async function sendTestAnnouncement(adminId: number, raw: unknown): Promise<SendCounts> {
  const text = validateAnnouncement(raw);
  const phones = listPhoneNumbersForUser(adminId).map((p) => p.phone);
  if (phones.length === 0) throw new Error("There's no WhatsApp number on your account to send a test to.");
  const counts: SendCounts = { sent: 0, failed: 0 };
  for (const phone of phones) {
    try {
      await sendOne(phone, text);
      counts.sent++;
    } catch (err) {
      console.error("announcements: test send failed", err);
      counts.failed++;
    }
  }
  return counts;
}

// Sends announcement `id` to every recipient who doesn't have it yet. Safe to call again for the
// same id: numbers that already got it are skipped, so a retry only reaches the ones that failed.
async function deliver(id: number, text: string): Promise<SendCounts> {
  const itemKey = `announcement:${id}`;
  let sent = 0;
  let failed = 0;
  for (const { ownerId, phone } of listAnnouncementRecipients()) {
    if (listProactiveDeliveryPhones(ownerId, itemKey).includes(phone)) {
      sent++;
      continue;
    }
    try {
      await sendOne(phone, text);
      recordProactiveDelivery(ownerId, itemKey, phone);
      sent++;
    } catch (err) {
      console.error(`announcements: send to owner ${ownerId} failed`, err);
      failed++;
    }
  }
  setAnnouncementCounts(id, sent, failed);
  return { sent, failed };
}

export async function sendAnnouncement(adminId: number, raw: unknown): Promise<SendCounts & { id: number }> {
  const text = validateAnnouncement(raw);
  const id = insertAnnouncement(text, adminId);
  return { id, ...(await deliver(id, text)) };
}

export async function retryAnnouncement(id: number): Promise<SendCounts> {
  const announcement = getAnnouncement(id);
  if (!announcement) throw new Error("No such update.");
  return deliver(id, announcement.text);
}
