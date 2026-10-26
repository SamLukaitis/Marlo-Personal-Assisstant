// Feature use: which of Marlo's tools people actually use, grouped into areas (Email,
// Calendar, Travel…), so we can see where to focus and what nobody touches. Recorded per answered
// message in ai/assistant.ts (recordFeatureMessage) and shown in the Portal's Feature use tab.
// Only tool names are kept, never what was said.

// The line handleMedia (routes/whatsappRoutes.ts) puts in front of a sent photo or document's
// extracted text. runAssistantChat looks for it to count "sent a photo or document".
export const DOCUMENT_SENT_MARKER = "[A document was just sent via WhatsApp";

// Not real tools: recorded alongside them so the Portal can show them in the same tables.
export const DOCUMENT_SENT_TOOL = "document_sent";
export const UNSUPPORTED_TOOL_PREFIX = "unsupported:";

export const FEATURE_AREAS = {
  email: "Email",
  calendar: "Calendar",
  reminders: "Reminders",
  memory: "Memory & people",
  files: "Files, photos & documents",
  travel: "Trips, flights & hotels",
  places: "Places & directions",
  web: "Web search",
  news: "News, weather & markets",
  money: "Spending & Xero",
  business: "Business books",
  teams: "Teams chats",
  phone: "Phone actions & app links",
  settings: "Briefings, alerts & setup",
  joyce: "Joyce link",
  unmet: "Asked for something Marlo can't do",
  unsupported: "Sent something Marlo can't read",
  chat: "Just conversation (no tools)",
} as const;

export type FeatureArea = keyof typeof FEATURE_AREAS;

// Every assistant tool needs an entry here (featureUsage.test.ts checks). "helper" tools are how
// Marlo talks (buttons, reactions, the time) rather than something a person came for, so they
// don't count toward an area: a message that only used helpers counts as "just conversation".
const TOOL_AREAS: Record<string, FeatureArea | "helper"> = {
  list_recent_messages: "email",
  search_messages: "email",
  get_message: "email",
  create_email_draft: "email",
  send_email: "email",
  archive_messages: "email",
  unsubscribe_from_sender: "email",
  label_message: "email",
  list_flagged_emails: "email",
  search_read_emails: "email",
  extract_email_attachment: "email",

  list_upcoming_events: "calendar",
  find_free_time: "calendar",
  create_calendar_event: "calendar",
  update_calendar_event: "calendar",
  delete_calendar_event: "calendar",

  set_reminder: "reminders",
  list_active_reminders: "reminders",
  cancel_reminder: "reminders",
  check_reminder_status: "reminders",

  search_memory: "memory",
  remember: "memory",
  forget_memory: "memory",
  recall_entity: "memory",
  search_contacts: "memory",
  search_conversation_history: "memory",

  search_files: "files",
  search_documents: "files",
  list_recent_documents: "files",
  send_document: "files",
  [DOCUMENT_SENT_TOOL]: "files",

  create_trip: "travel",
  link_to_trip: "travel",
  get_trip_contents: "travel",
  list_bookings: "travel",
  list_travel_checkins: "travel",
  count_travel_days: "travel",
  search_flights: "travel",
  search_hotels: "travel",

  find_places: "places",
  get_route: "places",
  request_location: "places",

  web_search: "web",

  get_news: "news",
  get_weather: "news",
  get_markets: "news",

  list_expenses: "money",
  undo_expense: "money",
  get_spending_digest: "money",
  connect_xero: "money",
  respond_to_invoice_forward_prompt: "money",

  set_business_profile: "business",
  log_expense: "business",
  log_income: "business",
  list_ledger: "business",
  confirm_ledger_entry: "business",
  update_ledger_entry: "business",
  remove_ledger_entry: "business",
  get_money_summary: "business",

  list_recent_chats: "teams",
  search_chats: "teams",

  make_app_link: "phone",
  make_phone_action: "phone",

  set_briefing_preferences: "settings",
  set_email_alerts: "settings",
  mute_email_alerts: "settings",
  set_tool_enabled: "settings",
  connect_email: "settings",
  list_needs_attention: "settings",

  family_link_status: "joyce",
  link_family: "joyce",
  update_family_link: "joyce",
  unlink_family: "joyce",
  send_to_family: "joyce",
  answer_trip_question: "joyce",

  flag_unmet_request: "unmet",

  get_current_time: "helper",
  ask_user_choice: "helper",
  react_to_message: "helper",
};

export function toolArea(tool: string): FeatureArea | "helper" | null {
  if (tool.startsWith(UNSUPPORTED_TOOL_PREFIX)) return "unsupported";
  return TOOL_AREAS[tool] ?? null;
}

// WhatsApp's message types, as a person would say them.
const UNSUPPORTED_LABELS: Record<string, string> = {
  audio: "a voice note",
  video: "a video",
  sticker: "a sticker",
  contacts: "a contact card",
};

// What the Portal calls a tool. Real tools keep their code name, which is what a developer
// searches for; the made-up ones get a readable one.
export function toolLabel(tool: string): string {
  if (tool === DOCUMENT_SENT_TOOL) return "Sent a photo or document";
  if (tool.startsWith(UNSUPPORTED_TOOL_PREFIX)) {
    const type = tool.slice(UNSUPPORTED_TOOL_PREFIX.length);
    return `Sent ${UNSUPPORTED_LABELS[type] ?? `a ${type} message`}`;
  }
  return tool;
}

export interface CatalogTool {
  name: string;
  // false: the tool exists but this server isn't set up for it (e.g. no Maps key), so nobody
  // could have used it.
  switchedOn: boolean;
}

export interface FeatureUsageInputRow {
  messageId: number;
  ownerId: number | null;
  createdAt: number;
  toolName: string | null;
  uses: number | null;
}

export interface FeatureAreaSummary {
  area: FeatureArea;
  label: string;
  messages: number;
  people: number;
}

export interface FeatureToolSummary {
  tool: string;
  label: string;
  area: FeatureArea | "helper" | null;
  areaLabel: string;
  uses: number;
  messages: number;
  people: number;
  lastUsedAt: number | null;
  switchedOn: boolean;
}

export interface FeaturePersonSummary {
  ownerId: number | null;
  messages: number;
  // Up to three, busiest first.
  topAreas: { label: string; messages: number }[];
  lastActiveAt: number;
}

export interface FeatureUsageSummary {
  totals: {
    messages: number;
    people: number;
    // Messages that used at least one non-helper tool.
    messagesWithTools: number;
  };
  areas: FeatureAreaSummary[];
  tools: FeatureToolSummary[];
  people: FeaturePersonSummary[];
}

function areaLabel(area: FeatureArea | "helper" | null): string {
  if (area === "helper") return "How Marlo replies";
  if (area === null) return "Other";
  return FEATURE_AREAS[area];
}

// Rows come one per message+tool (a message with no tools has one row with toolName null). A
// message counts once per area and once per tool, however many times it used it.
export function summariseFeatureUsage(rows: FeatureUsageInputRow[], catalog: CatalogTool[]): FeatureUsageSummary {
  const messages = new Map<number, { ownerId: number | null; createdAt: number; areas: Set<FeatureArea> }>();
  const tools = new Map<string, { uses: number; messages: Set<number>; people: Set<number | null>; lastUsedAt: number }>();

  for (const r of rows) {
    let m = messages.get(r.messageId);
    if (!m) {
      m = { ownerId: r.ownerId, createdAt: r.createdAt, areas: new Set() };
      messages.set(r.messageId, m);
    }
    if (r.toolName === null) continue;
    const area = toolArea(r.toolName);
    if (area && area !== "helper") m.areas.add(area);
    let t = tools.get(r.toolName);
    if (!t) {
      t = { uses: 0, messages: new Set(), people: new Set(), lastUsedAt: 0 };
      tools.set(r.toolName, t);
    }
    t.uses += r.uses ?? 1;
    t.messages.add(r.messageId);
    t.people.add(r.ownerId);
    t.lastUsedAt = Math.max(t.lastUsedAt, r.createdAt);
  }

  const areaMessages = new Map<FeatureArea, number>();
  const areaPeople = new Map<FeatureArea, Set<number | null>>();
  const people = new Map<number | null, { messages: number; areas: Map<FeatureArea, number>; lastActiveAt: number }>();
  let messagesWithTools = 0;
  for (const m of messages.values()) {
    const areas: FeatureArea[] = m.areas.size > 0 ? [...m.areas] : ["chat"];
    if (m.areas.size > 0) messagesWithTools++;
    let p = people.get(m.ownerId);
    if (!p) {
      p = { messages: 0, areas: new Map(), lastActiveAt: 0 };
      people.set(m.ownerId, p);
    }
    p.messages++;
    p.lastActiveAt = Math.max(p.lastActiveAt, m.createdAt);
    for (const a of areas) {
      areaMessages.set(a, (areaMessages.get(a) ?? 0) + 1);
      if (!areaPeople.has(a)) areaPeople.set(a, new Set());
      areaPeople.get(a)!.add(m.ownerId);
      p.areas.set(a, (p.areas.get(a) ?? 0) + 1);
    }
  }

  // Every area is listed, used or not: the unused ones are half the point.
  const areaRows: FeatureAreaSummary[] = (Object.keys(FEATURE_AREAS) as FeatureArea[])
    .map((area) => ({
      area,
      label: FEATURE_AREAS[area],
      messages: areaMessages.get(area) ?? 0,
      people: areaPeople.get(area)?.size ?? 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  // Every catalog tool, plus anything recorded that isn't in it (a sent photo, a voice note, or a
  // tool since removed).
  const switchedOn = new Map(catalog.map((t) => [t.name, t.switchedOn]));
  const names = new Set([...catalog.map((t) => t.name), ...tools.keys()]);
  const toolRows: FeatureToolSummary[] = [...names]
    .map((name) => {
      const t = tools.get(name);
      const area = toolArea(name);
      return {
        tool: name,
        label: toolLabel(name),
        area,
        areaLabel: areaLabel(area),
        uses: t?.uses ?? 0,
        messages: t?.messages.size ?? 0,
        people: t?.people.size ?? 0,
        lastUsedAt: t ? t.lastUsedAt : null,
        switchedOn: switchedOn.get(name) ?? true,
      };
    })
    .sort((a, b) => b.uses - a.uses || a.tool.localeCompare(b.tool));

  const personRows: FeaturePersonSummary[] = [...people.entries()]
    .map(([ownerId, p]) => ({
      ownerId,
      messages: p.messages,
      topAreas: [...p.areas.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([area, count]) => ({ label: FEATURE_AREAS[area], messages: count })),
      lastActiveAt: p.lastActiveAt,
    }))
    .sort((a, b) => b.messages - a.messages);

  return {
    totals: { messages: messages.size, people: people.size, messagesWithTools },
    areas: areaRows,
    tools: toolRows,
    people: personRows,
  };
}
