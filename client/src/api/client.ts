// In local dev the client (Vite, port 5173) and server (port 4000) run as separate
// processes, so client/.env sets VITE_API_BASE to reach the server explicitly. In
// production the server serves this built client itself (see server/src/index.ts),
// so with no VITE_API_BASE set at build time we default to "" — same-origin, relative
// requests — rather than hardcoding a localhost URL that would never work when deployed.
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// credentials: "include" on every request is required for the session cookie to actually be
// sent — the browser won't attach cookies cross-origin by default (local dev genuinely is
// cross-origin: client :5173, server :4000), and relying on same-origin-only default behavior
// would silently break local dev even though production happens to be same-origin.
function withCredentials(init?: RequestInit): RequestInit {
  return { ...init, credentials: "include" };
}

export type Provider = "google" | "microsoft" | "local";

export interface ProviderInfo {
  provider: Provider;
  label: string;
  configured: boolean;
  loginPath: string;
}

export interface Account {
  id: number;
  provider: Provider;
  email: string;
  authBroken: boolean;
  authBrokenAt: number | null;
}

export interface Me {
  id: number;
  email: string;
}

export interface UnifiedMessage {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  link?: string;
}

export interface CalendarEvent {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  title: string;
  start: string;
  end: string;
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
  modifiedAt: string;
  link?: string;
}

export interface ChatThread {
  id: string;
  accountId: number;
  accountEmail: string;
  provider: Provider;
  topic: string;
  lastSender: string;
  preview: string;
  updatedAt: string;
  link?: string;
}

export interface LocalFolder {
  id: number;
  path: string;
  label: string | null;
}

export interface Settings {
  assistantName: string;
  persona: string;
}

export type NewsTopic = "world" | "technology" | "business" | "sports";

export const NEWS_TOPIC_LABELS: Record<NewsTopic, string> = {
  world: "World",
  technology: "Technology",
  business: "Business",
  sports: "Sports",
};

export interface BriefingSettings {
  enabled: boolean;
  includeNews: boolean;
  topics: NewsTopic[];
  proactive: boolean;
  sendTime: string;
}

export interface Briefing {
  date: string;
  content: string;
}

export interface MemoryNote {
  id: number;
  content: string;
  createdAt: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface WhatsAppStatus {
  configured: boolean;
  signatureConfigured: boolean;
}

export interface StoredDocument {
  id: number;
  phone: string;
  filename: string | null;
  mimeType: string;
  caption: string | null;
  extractedText: string;
  createdAt: number;
}

export interface TravelCheckin {
  id: number;
  latitude: number | null;
  longitude: number | null;
  country: string | null;
  city: string | null;
  checkedInAt: number;
  source: "phone" | "document";
  documentId: number | null;
}

export interface TravelDaysResult {
  area: string;
  sinceDate: string;
  untilDate: string;
  daysPresent: number;
  totalDaysInWindow: number;
  checkinsConsidered: number;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, withCredentials());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json();
}

// Thrown specifically so callers (AuthContext) can tell "not logged in" apart from a real
// server error — a plain 401 from getJson would otherwise look identical to any other failure.
export class UnauthorizedError extends Error {
  constructor() {
    super("not logged in");
    this.name = "UnauthorizedError";
  }
}

export async function fetchMe(): Promise<Me> {
  const res = await fetch(`${API_BASE}/api/me`, withCredentials());
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, withCredentials({ method: "POST" }));
}

export const fetchProviders = () => getJson<ProviderInfo[]>("/api/providers");
export const fetchAccounts = () => getJson<Account[]>("/api/accounts");
export const fetchMessages = (q?: string) =>
  getJson<UnifiedMessage[]>(`/api/messages${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const fetchEvents = (days = 7) => getJson<CalendarEvent[]>(`/api/events?days=${days}`);
export const fetchFiles = (q: string) =>
  getJson<FileHit[]>(`/api/files?q=${encodeURIComponent(q)}`);
export const fetchSettings = () => getJson<Settings>("/api/settings");
export const fetchChats = (q?: string) =>
  getJson<ChatThread[]>(`/api/chats${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const fetchLocalFolders = () => getJson<LocalFolder[]>("/api/local-folders");

export async function addLocalFolder(path: string): Promise<LocalFolder> {
  const res = await fetch(
    `${API_BASE}/api/local-folders`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to add folder");
  }
  return res.json();
}

export async function removeLocalFolder(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/local-folders/${id}`, withCredentials({ method: "DELETE" }));
}

export function loginUrl(loginPath: string): string {
  return `${API_BASE}${loginPath}`;
}

export async function disconnectAccount(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/accounts/${id}`, withCredentials({ method: "DELETE" }));
}

export async function saveSettings(settings: Settings): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/settings`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
  if (!res.ok) throw new Error("failed to save settings");
}

export const fetchBriefing = () => getJson<Briefing>("/api/briefing");
export const fetchBriefingSettings = () => getJson<BriefingSettings>("/api/briefing/settings");

export async function refreshBriefing(): Promise<Briefing> {
  const res = await fetch(`${API_BASE}/api/briefing/refresh`, withCredentials({ method: "POST" }));
  if (!res.ok) throw new Error("failed to refresh briefing");
  return res.json();
}

export async function saveBriefingSettings(settings: BriefingSettings): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/briefing/settings`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
  if (!res.ok) throw new Error("failed to save briefing settings");
}

export interface AlertSettings {
  enabled: boolean;
}

export const fetchAlertSettings = () => getJson<AlertSettings>("/api/alerts/settings");

export async function saveAlertSettings(settings: AlertSettings): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/alerts/settings`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
  if (!res.ok) throw new Error("failed to save alert settings");
}

export const fetchMemoryNotes = () => getJson<MemoryNote[]>("/api/memory");

export async function addMemoryNote(content: string): Promise<MemoryNote> {
  const res = await fetch(
    `${API_BASE}/api/memory`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to add memory note");
  }
  return res.json();
}

export async function removeMemoryNote(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/memory/${id}`, withCredentials({ method: "DELETE" }));
}

export const fetchWhatsAppStatus = () => getJson<WhatsAppStatus>("/api/whatsapp/status");
export const fetchWhatsAppAllowedNumbers = () =>
  getJson<string[]>("/api/whatsapp/allowed-numbers");

export async function saveWhatsAppAllowedNumbers(numbers: string[]): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/whatsapp/allowed-numbers`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numbers }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to save allowed numbers");
  }
}

export const fetchDocuments = () => getJson<StoredDocument[]>("/api/documents");

export function documentFileUrl(id: number): string {
  return `${API_BASE}/api/documents/${id}/file`;
}

export async function deleteDocument(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/documents/${id}`, withCredentials({ method: "DELETE" }));
}

export interface SearchResults {
  messages: UnifiedMessage[];
  files: FileHit[];
  chats: ChatThread[];
  documents: StoredDocument[];
}

export const fetchSearchAll = (q: string) =>
  getJson<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`);

export const fetchCheckins = () => getJson<TravelCheckin[]>("/api/checkins");
export const fetchTravelDays = (area = "schengen", days = 180) =>
  getJson<TravelDaysResult>(`/api/travel-days?area=${encodeURIComponent(area)}&days=${days}`);

export async function sendChatMessage(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/assistant/chat`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "assistant request failed");
  }
  const data = await res.json();
  return data.reply as string;
}
