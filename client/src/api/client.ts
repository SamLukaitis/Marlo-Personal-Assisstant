const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

export type Provider = "google" | "microsoft";

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

export interface Settings {
  assistantName: string;
  persona: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  return res.json();
}

export const fetchProviders = () => getJson<ProviderInfo[]>("/api/providers");
export const fetchAccounts = () => getJson<Account[]>("/api/accounts");
export const fetchMessages = (q?: string) =>
  getJson<UnifiedMessage[]>(`/api/messages${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const fetchEvents = (days = 7) => getJson<CalendarEvent[]>(`/api/events?days=${days}`);
export const fetchFiles = (q: string) =>
  getJson<FileHit[]>(`/api/files?q=${encodeURIComponent(q)}`);
export const fetchSettings = () => getJson<Settings>("/api/settings");

export function loginUrl(loginPath: string): string {
  return `${API_BASE}${loginPath}`;
}

export async function disconnectAccount(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/accounts/${id}`, { method: "DELETE" });
}

export async function saveSettings(settings: Settings): Promise<void> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("failed to save settings");
}

export async function sendChatMessage(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${API_BASE}/api/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "assistant request failed");
  }
  const data = await res.json();
  return data.reply as string;
}
