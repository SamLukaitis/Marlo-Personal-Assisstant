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
  canRead: boolean;
  canSend: boolean;
  canDelete: boolean;
}

export interface Me {
  id: number;
  email: string;
  /** The single APP_OWNER_EMAIL account — gates the narrower invites/reset-test-phone section in Settings. */
  isAppOwner: boolean;
  /** The app owner plus anyone promoted via the Portal's Admins tab — gates the Portal itself. */
  isAdmin: boolean;
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

export type NewsTopic =
  | "world"
  | "technology"
  | "business"
  | "sports"
  | "politics"
  | "science"
  | "health"
  | "entertainment";

export const NEWS_TOPIC_LABELS: Record<NewsTopic, string> = {
  world: "World",
  technology: "Technology",
  business: "Business",
  sports: "Sport",
  politics: "Politics",
  science: "Science",
  health: "Health",
  entertainment: "Culture",
};

export interface BriefingSettings {
  enabled: boolean;
  includeNews: boolean;
  topics: NewsTopic[];
  includeMarkets: boolean;
  tickers: string[];
  includeWeather: boolean;
  weatherLocation: string;
  proactive: boolean;
  sendTime: string;
}

export const DEFAULT_BRIEFING_SETTINGS: BriefingSettings = {
  enabled: true,
  includeNews: false,
  topics: [],
  includeMarkets: false,
  tickers: [],
  includeWeather: false,
  weatherLocation: "",
  proactive: false,
  sendTime: "07:30",
};

export interface Briefing {
  date: string;
  content: string;
}

export interface Headline {
  topic: NewsTopic;
  title: string;
  link?: string;
}

export interface Quote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string | null;
}

export interface WeatherReport {
  place: string;
  tempC: number;
  highC: number;
  lowC: number;
  condition: string;
}

export interface BriefingFeed {
  headlines: Headline[];
  quotes: Quote[];
  weather: WeatherReport | null;
}

export const fetchNews = (topics?: NewsTopic[]) =>
  getJson<Headline[]>(`/api/news${topics?.length ? `?topics=${topics.join(",")}` : ""}`);

export const fetchBriefingFeed = () => getJson<BriefingFeed>("/api/briefing/feed");

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

export type DocumentCategory = "travel" | "id_legal" | "receipts" | "other";

export const DOCUMENT_CATEGORIES: DocumentCategory[] = ["travel", "id_legal", "receipts", "other"];

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  travel: "Travel",
  id_legal: "ID & Legal",
  receipts: "Receipts",
  other: "Other",
};

export interface StoredDocument {
  id: number;
  phone: string;
  filename: string | null;
  mimeType: string;
  caption: string | null;
  /** Assigned during extraction. Null for documents saved before auto-titling shipped. */
  title: string | null;
  extractedText: string;
  /** Assigned during extraction, same call as title. Null predates this feature or wasn't analyzable. */
  category: DocumentCategory | null;
  createdAt: number;
  /** Set only for documents extracted from a connected inbox — which one, by email address. */
  emailAccountEmail: string | null;
}

/** What to show as a document's headline: its title, else its filename, else its type. */
export function documentLabel(doc: StoredDocument): string {
  if (doc.title?.trim()) return doc.title;
  if (doc.filename?.trim()) return doc.filename;
  return doc.mimeType === "application/pdf" ? "PDF document" : "Saved file";
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

// Shared by the Portal's ~15 write endpoints (portalRoutes.ts) — the existing invite/reset-test-
// phone helpers below hand-write this each time, but that'd mean a lot of near-identical
// boilerplate at Portal's size.
async function mutateJson<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(
    `${API_BASE}${path}`,
    withCredentials({
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error ?? `request failed (${res.status})`);
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

// Public marketing-site help widget — reachable by logged-out visitors, so deliberately doesn't
// use withCredentials()/session cookies (there's nothing to authenticate; the endpoint has no
// access to real user data by design, see server/src/ai/assistant.ts's getHelpChatReply).
export interface HelpChatTurn {
  role: "user" | "assistant";
  text: string;
}

export async function sendHelpChatMessage(message: string, history: HelpChatTurn[]): Promise<string> {
  const res = await fetch(`${API_BASE}/api/help-chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed (${res.status})`);
  }
  const data = await res.json();
  return data.reply as string;
}

export async function disconnectAccount(id: number): Promise<void> {
  await fetch(`${API_BASE}/api/accounts/${id}`, withCredentials({ method: "DELETE" }));
}

export async function updateAccountPermissions(
  id: number,
  patch: Partial<{ canRead: boolean; canSend: boolean; canDelete: boolean }>
): Promise<void> {
  await fetch(
    `${API_BASE}/api/accounts/${id}/permissions`,
    withCredentials({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
  );
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

export interface ImportantEmailAlertSettings {
  enabled: boolean;
}

export const fetchImportantEmailAlertSettings = () =>
  getJson<ImportantEmailAlertSettings>("/api/important-email-alerts/settings");

export async function saveImportantEmailAlertSettings(settings: ImportantEmailAlertSettings): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/important-email-alerts/settings`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  );
  if (!res.ok) throw new Error("failed to save important-email alert settings");
}

export interface Tool {
  key: "teams" | "travel";
  label: string;
  description: string;
  enabled: boolean;
}

export const fetchTools = () => getJson<Tool[]>("/api/tools");

export async function setToolEnabled(key: Tool["key"], enabled: boolean): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/tools/${key}`,
    withCredentials({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    })
  );
  if (!res.ok) throw new Error("failed to update tool");
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

export const fetchDocuments = (category?: DocumentCategory) =>
  getJson<StoredDocument[]>(category ? `/api/documents?category=${category}` : "/api/documents");

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

// Invite-only access is gated by phone number, not email — send a tester the WhatsApp number to
// message and add their number here; no need to collect their email in advance.
export interface InvitedPhone {
  phone: string;
  invitedAt: number;
}

export const fetchInvites = () => getJson<InvitedPhone[]>("/api/admin/invites");

export async function addInvite(phone: string): Promise<InvitedPhone[]> {
  const res = await fetch(
    `${API_BASE}/api/admin/invites`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to add invite");
  }
  return res.json();
}

export async function removeInvite(phone: string): Promise<InvitedPhone[]> {
  const res = await fetch(
    `${API_BASE}/api/admin/invites/${encodeURIComponent(phone)}`,
    withCredentials({ method: "DELETE" })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to remove invite");
  }
  return res.json();
}

// Wipes any in-progress WhatsApp registration for this number, and if it's already bound to a
// full account, wipes that account entirely — so the same phone/email can go through the
// WhatsApp-native signup flow again from scratch. Irreversible; the caller should confirm first.
export async function resetTestPhone(phone: string): Promise<{ ok: true; hadAccount: boolean }> {
  const res = await fetch(
    `${API_BASE}/api/admin/reset-test-phone`,
    withCredentials({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    })
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const offenders = Array.isArray(body.offenders) ? body.offenders : [];
    const suffix = offenders.length > 0 ? ` — blocked by: ${offenders.join(", ")}` : "";
    throw new Error((body.error ?? "failed to reset that number") + suffix);
  }
  return res.json();
}

// Replays the WhatsApp onboarding UX on your OWN account without losing your data — unlike
// resetTestPhone above, this never deletes usage, to-dos, poster board, documents, memory, or
// chat history. It only unbinds your phone number(s) and clears the OAuth connection + post-
// connect setup state, so the next message from that number re-enters the onboarding flow and
// reconnects the SAME account once it goes through OAuth again.
export async function replayOnboarding(): Promise<{ ok: true; unboundPhones: string[] }> {
  const res = await fetch(`${API_BASE}/api/admin/replay-onboarding`, withCredentials({ method: "POST" }));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "failed to reset onboarding state");
  }
  return res.json();
}

// One entry in the admin conversation viewer's timeline — either a real WhatsApp message or an
// onboarding_step_events marker (see db/store.ts), already merged and sorted server-side.
export interface AdminTimelineEntry {
  kind: "message" | "step";
  createdAt: number;
  role?: "user" | "assistant";
  content?: string;
  step?: string;
  event?: "reached" | "completed";
}

export const fetchAdminMessages = (phone: string) =>
  getJson<{ ownerId: number; timeline: AdminTimelineEntry[] }>(
    `/api/admin/messages?phone=${encodeURIComponent(phone)}`
  );

// --- Admin Portal -----------------------------------------------------------------------------

export interface AdminCandidate {
  id: number;
  email: string;
  isAdmin: boolean;
  isAppOwner: boolean;
  createdAt: number;
}

export const fetchAdminCandidates = () => getJson<AdminCandidate[]>("/api/portal/admins");
export const grantAdmin = (userId: number) =>
  mutateJson<AdminCandidate[]>(`/api/portal/admins/${userId}`, "POST");
export const revokeAdmin = (userId: number) =>
  mutateJson<AdminCandidate[]>(`/api/portal/admins/${userId}`, "DELETE");

export interface UnmetRequest {
  id: number;
  ownerId: number;
  summary: string;
  channel: string;
  createdAt: number;
  resolvedAt: number | null;
}

export const fetchUnmetRequests = (includeResolved = false) =>
  getJson<UnmetRequest[]>(`/api/portal/unmet-requests?includeResolved=${includeResolved}`);
export const resolveUnmetRequest = (id: number) =>
  mutateJson<{ ok: true }>(`/api/portal/unmet-requests/${id}/resolve`, "POST");

export interface ServerLog {
  id: number;
  level: string;
  message: string;
  createdAt: number;
  explanation: string | null;
  explainedAt: number | null;
}

export const fetchServerLogs = (limit = 200) => getJson<ServerLog[]>(`/api/portal/logs?limit=${limit}`);
export const explainServerLog = (id: number) =>
  mutateJson<{ explanation: string; cached: boolean }>(`/api/portal/logs/${id}/explain`, "POST");

// cacheReadTokens/cacheCreationTokens are the prompt-caching tokens (the tools+system prefix the
// assistant re-reads on every internal turn) — inputTokens deliberately excludes them, matching
// how the API reports usage, so the two must be added together for an "all tokens" figure.
export interface ApiUsageRow {
  day: string;
  channel: string;
  model: string;
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number | null;
}

export interface ApiUsageByPurposeRow {
  purpose: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number | null;
}

export interface ApiUsageByOwnerRow {
  ownerEmail: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCost: number | null;
}

export interface ApiUsageProjection {
  day: string;
  dayCost: number;
  projectedMonthlyCost: number;
}

export interface ApiUsageCallRow {
  id: number;
  ownerEmail: string | null;
  channel: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  createdAt: number;
  estimatedCost: number | null;
}

// Maps the internal purpose tags (assistant.ts, documents.ts, etc.) to what an admin actually
// reads — keep this in sync whenever a new call site starts calling recordApiUsage.
export const USAGE_PURPOSE_LABELS: Record<string, string> = {
  assistant_chat: "Assistant chat (web + WhatsApp)",
  help_widget: "Public help widget",
  registration_assist: "WhatsApp sign-up assistant",
  log_explanation: "Portal log explanations",
  email_importance_classifier: "Important-email scanning",
  daily_briefing: "Daily briefing",
  conversation_summary: "WhatsApp memory summarization",
  document_extraction: "Document/photo extraction",
  pdf_gibberish_check: "PDF text-quality check",
};

export function usagePurposeLabel(purpose: string): string {
  return USAGE_PURPOSE_LABELS[purpose] ?? purpose;
}

export const fetchUsageSummary = (days = 30, recentLimit = 50) =>
  getJson<{
    rows: ApiUsageRow[];
    byPurpose: ApiUsageByPurposeRow[];
    byOwner: ApiUsageByOwnerRow[];
    projection: ApiUsageProjection | null;
    recent: ApiUsageCallRow[];
    approx: true;
  }>(`/api/portal/usage?days=${days}&recentLimit=${recentLimit}`);

export interface AdminTodoReply {
  id: number;
  todoId: number;
  text: string;
  authorId: number;
  authorEmail: string;
  createdAt: number;
}

export interface AdminTodo {
  id: number;
  text: string;
  done: boolean;
  createdBy: number;
  createdByEmail: string;
  createdAt: number;
  doneAt: number | null;
  replies: AdminTodoReply[];
  // Personal to whichever admin fetched this list — see store.ts's listAdminTodos.
  unreadReplyCount: number;
}

export const fetchAdminTodos = () => getJson<AdminTodo[]>("/api/portal/todos");
export const addAdminTodo = (text: string) => mutateJson<AdminTodo[]>("/api/portal/todos", "POST", { text });
export const setAdminTodoDone = (id: number, done: boolean) =>
  mutateJson<AdminTodo[]>(`/api/portal/todos/${id}`, "PUT", { done });
export const deleteAdminTodo = (id: number) =>
  mutateJson<AdminTodo[]>(`/api/portal/todos/${id}`, "DELETE");
export const addAdminTodoReply = (id: number, text: string) =>
  mutateJson<AdminTodo[]>(`/api/portal/todos/${id}/replies`, "POST", { text });
export const markAdminTodoRepliesRead = (id: number) =>
  mutateJson<AdminTodo[]>(`/api/portal/todos/${id}/read`, "POST");

export interface PosterNote {
  id: number;
  authorId: number;
  authorEmail: string;
  text: string;
  createdAt: number;
}

export const fetchPosterNotes = () => getJson<PosterNote[]>("/api/portal/notes");
export const addPosterNote = (text: string) => mutateJson<PosterNote[]>("/api/portal/notes", "POST", { text });
export const deletePosterNote = (id: number) => mutateJson<{ ok: true }>(`/api/portal/notes/${id}`, "DELETE");

export const fetchPortalVersion = () => getJson<{ text: string }>("/api/portal/version");

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
