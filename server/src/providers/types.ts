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
  link?: string;
  body?: string; // only populated by getMessage
}

export interface CalendarEvent {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  title: string;
  start: string; // ISO date
  end: string; // ISO date
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
  location?: string;
  description?: string;
}
