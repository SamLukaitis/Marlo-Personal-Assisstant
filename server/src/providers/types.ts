import type { Provider } from "../db/store.js";

export interface UnifiedMessage {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string; // ISO date
  unread: boolean;
  // Set when the provider itself says this is bulk/marketing mail (Gmail's Promotions/Social/
  // Updates/Forums tabs, or a List-Unsubscribe header) — see hub.ts's isAutomatedMail. Absent
  // where the provider gives no such signal (Microsoft, for now).
  bulk?: boolean;
  link?: string;
  body?: string; // only populated by getMessage
  attachments?: EmailAttachmentMeta[]; // only populated by getMessage
}

export interface CalendarEvent {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  title: string;
  // A zoned ISO datetime ("...Z" or "...+02:00"), or for an all-day event a plain "YYYY-MM-DD"
  // (end exclusive). Compare/bucket these with services/eventTime.ts, never new Date() or strings.
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  link?: string;
}

export interface FileHit {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  name: string;
  mimeType: string;
  modifiedAt: string; // ISO date
  link?: string;
}

export interface DraftResult {
  draftId: string;
  provider: Provider;
  accountEmail: string;
  reviewNote: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Buffer;
}

export interface EmailAttachmentMeta {
  id: string; // provider-specific attachment id, opaque outside its own provider
  filename: string;
  mimeType: string;
  size: number;
}

export interface SendResult {
  messageId: string;
  provider: Provider;
  accountEmail: string;
}

export interface ChatThread {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  topic: string;
  lastSender: string;
  preview: string;
  updatedAt: string; // ISO date
  link?: string;
}

export interface ContactHit {
  name: string;
  email: string;
  provider: Provider;
  accountId: number;
  accountEmail: string;
}

export interface EventInput {
  title: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  // IANA timezone name (e.g. "America/Bogota") for start/end, only when the event happens
  // somewhere other than the user's home timezone (a flight, a trip abroad). When set, `start`/
  // `end` are the plain local clock time at that place (no Z/offset) — the provider is told to
  // interpret them in this zone, rather than the caller doing UTC conversion itself. A flight's
  // departure and arrival cities can be in different zones, so these are independent. Omitted for
  // an ordinary event in the user's own timezone, preserving the previous UTC/'Z' behavior.
  startTimeZone?: string;
  endTimeZone?: string;
  location?: string;
  description?: string;
}
