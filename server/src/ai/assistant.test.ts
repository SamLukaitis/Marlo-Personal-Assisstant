import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIngestEmailAttachment = vi.fn();
const mockIngestEmailBodyReceipt = vi.fn();
const mockSendSavedDocumentFile = vi.fn();
vi.mock("../services/documents.js", () => ({
  ingestEmailAttachment: (...args: unknown[]) => mockIngestEmailAttachment(...args),
  ingestEmailBodyReceipt: (...args: unknown[]) => mockIngestEmailBodyReceipt(...args),
  sendSavedDocumentFile: (...args: unknown[]) => mockSendSavedDocumentFile(...args),
}));

const mockHubGetMessage = vi.fn();
const mockHubCreateEvent = vi.fn();
const mockHubUpdateEvent = vi.fn();
vi.mock("../services/hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/hub.js")>();
  return {
    ...actual,
    hubGetMessage: (...args: unknown[]) => mockHubGetMessage(...args),
    hubCreateEvent: (...args: unknown[]) => mockHubCreateEvent(...args),
    hubUpdateEvent: (...args: unknown[]) => mockHubUpdateEvent(...args),
  };
});

import {
  buildToolsForOwner,
  buildSystemPrompt,
  runTool,
  messageForModel,
  trimSnippetForList,
} from "./assistant.js";
import type { UnifiedMessage } from "../providers/types.js";
import {
  findOrCreateUserByEmail,
  addPhoneNumberForUser,
  createPendingAction,
  consumePendingAction,
  setToolEnabled,
  getEnabledTools,
  listMemoryNotes,
  setPendingSetup,
  listUnmetRequests,
  findEntityByName,
  listActiveFactsForEntity,
  getRelatedEntities,
  linkRecords,
  appendWhatsAppMessage,
  saveEntity,
  upsertReadEmail,
  listActiveRemindersForOwner,
  listCoreProfile,
  searchMemoryNotes,
  addFact,
  listEntities,
  listEntityRelations,
} from "../db/store.js";
import { retrieveRelevantMemory } from "./memoryRetrieval.js";
import { IMPORTANT_EMAIL_ENTITY_TYPE } from "../services/importantEmailAlerts.js";
import { getBriefingSettings, saveBriefingSettings, type BriefingSettings } from "../services/briefing.js";
import { getXeroForwardingEmail } from "../services/xero.js";
import {
  emailDigestTime,
  importantEmailAlertsEnabled,
  realPersonAlertMode,
  realPersonAlertsEnabled,
} from "../services/emailAlertSettings.js";
import { setPendingInvoiceForward, getPendingInvoiceForward } from "../services/xeroInvoiceConfirmation.js";
import { setUserTimezone } from "../services/userTimezone.js";

let counter = 0;
function uniqueEmail(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}@example.com`;
}

describe("buildToolsForOwner", () => {
  it("excludes teams and travel tools when neither is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("no-tools"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).not.toContain("list_recent_chats");
    expect(names).not.toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
    expect(names).not.toContain("count_travel_days");
  });

  it("includes teams tools when teams is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("teams-on"));
    setToolEnabled(user.id, "teams", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_recent_chats");
    expect(names).toContain("search_chats");
    expect(names).not.toContain("list_travel_checkins");
  });

  it("includes travel tools when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("travel-on"));
    setToolEnabled(user.id, "travel", true);
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_travel_checkins");
    expect(names).toContain("count_travel_days");
  });

  it("includes web_search for every user, regardless of which conditional tools are enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("web-search"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("web_search");
  });

  it("puts the cache_control breakpoint on the last tool in the array, whichever one that is", () => {
    const userNoTools = findOrCreateUserByEmail(uniqueEmail("cache-none"));
    const noToolsResult = buildToolsForOwner(userNoTools.id);
    expect(noToolsResult[noToolsResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    const userWithTravel = findOrCreateUserByEmail(uniqueEmail("cache-travel"));
    setToolEnabled(userWithTravel.id, "travel", true);
    const withTravelResult = buildToolsForOwner(userWithTravel.id);
    expect(withTravelResult[withTravelResult.length - 1].name).toBe("count_travel_days");
    expect(withTravelResult[withTravelResult.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });

  it("includes all 4 conditional tools with no duplicates when both teams and travel are enabled", () => {
    const userNeitherEnabled = findOrCreateUserByEmail(uniqueEmail("both-baseline"));
    const alwaysOnCount = buildToolsForOwner(userNeitherEnabled.id).length;

    const user = findOrCreateUserByEmail(uniqueEmail("both-on"));
    setToolEnabled(user.id, "teams", true);
    setToolEnabled(user.id, "travel", true);
    const result = buildToolsForOwner(user.id);
    const names = result.map((t) => t.name);

    expect(names).toContain("list_recent_chats");
    expect(names).toContain("search_chats");
    expect(names).toContain("list_travel_checkins");
    expect(names).toContain("count_travel_days");

    // No duplicates anywhere in the assembled array.
    expect(new Set(names).size).toBe(names.length);
    // Exactly the always-on tools plus the 4 conditional ones — nothing dropped, nothing doubled.
    expect(result.length).toBe(alwaysOnCount + 4);

    // Cache breakpoint lands on whichever tool is actually last — read it from the array rather
    // than assuming which tool that is.
    expect(result[result.length - 1].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    // And it must be the ONLY tool carrying cache_control.
    const withCache = result.filter((t) => t.cache_control !== undefined);
    expect(withCache.length).toBe(1);
    expect(withCache[0].name).toBe(result[result.length - 1].name);
  });
});

describe("buildSystemPrompt anti-hallucination rule", () => {
  it("forbids asserting absence of data without a fresh tool call this turn", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-hallucinate"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("does NOT exist");
    expect(prompt).toContain("not verification");
  });

  it("tells the model to fall back to email search when list_bookings/list_expenses is empty", () => {
    // Found by the grounding eval (server/src/eval/): the model was checking list_bookings/
    // list_expenses for "do I have a hotel booking" style questions and stopping there, never
    // falling back to search_messages when a confirmation/invoice email existed but nothing had
    // been extracted into a structured record yet.
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-bookings-fallback"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("list_bookings/list_expenses");
    expect(prompt).toContain("do NOT search email");
  });

  it("tells the model to search multiple concrete sub-terms for a broad/topic-level ask", () => {
    // Found reviewing a real conversation: asking about "bookings for South America" took several
    // manual pushes to find a Brazil flight, and never found Ipanema/Copacabana bookings at all —
    // search_messages was only ever called with the broad topic phrase itself, which rarely
    // appears verbatim in a real subject line.
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-broad-search"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("multiple times with different concrete sub-terms");
  });

  // Two independent reports of the same hole, a month apart: a reservation confirmation missed on
  // "anything else in email", and six Railway crash alerts plus a Google security notice sitting
  // unseen while "find anything important" reported a clean inbox. Both came from
  // list_needs_attention deliberately excluding automated senders (AUTOMATED_SENDER_PATTERN,
  // hub.ts) with nothing telling the model so. Closed in both places the model can learn it:
  it("tells the model list_needs_attention alone isn't enough for a broad 'anything important' ask", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-needs-attention-fallback"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("list_needs_attention only covers unread mail from real people");
  });

  // ...and on the tool's own description, which is what the model reads when deciding whether one
  // call is enough — the system-prompt rule alone leaves the tool still describing itself as the
  // answer to "what needs attention".
  it("warns on the tool description itself that it is not a complete sweep", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("tool-needs-attention-sweep"));
    const tool = buildToolsForOwner(user.id).find(
      (t) => "name" in t && t.name === "list_needs_attention"
    );
    expect(tool).toBeDefined();
    expect((tool as { description: string }).description).toContain("NOT a complete");
  });
});

describe("buildSystemPrompt", () => {
  it("omits travel-specific rules when travel is disabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-travel"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("count_travel_days");
  });

  it("includes travel-specific rules when travel is enabled", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-travel"));
    setToolEnabled(user.id, "travel", true);
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("count_travel_days");
  });

  it("frames memory as something the assistant may proactively volunteer", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-proactive-memory"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("may naturally bring up");
    expect(prompt).not.toContain("Things you've learned about the user over past conversations");
  });

  it("tells the assistant not to force or repeat remembered things, from the profile or the relevant-memory block", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-no-repeat"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("without forcing it or repeating something you've already brought up this conversation");
    expect(prompt).toMatch(/applies equally to the things shown alongside the user's latest message/);
  });

  it("renders active core facts as the profile and leaves other facts out of the system prompt", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-profile"));
    addFact(user.id, { content: "The user's name is Sam", kind: "core" });
    addFact(user.id, { content: "Likes jazz", kind: "preference" });
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("What you know about the user (core profile)");
    expect(prompt).toContain("- The user's name is Sam");
    expect(prompt).not.toContain("Likes jazz");
  });

  it("shows a placeholder when there is no core profile yet", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-empty"));
    expect(buildSystemPrompt(user.id)).toContain("(nothing known yet)");
  });

  it("is byte-identical after a non-core fact is added (system cache stays warm)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-core-stable"));
    addFact(user.id, { content: "The user's name is Sam", kind: "core" });
    const before = buildSystemPrompt(user.id);
    addFact(user.id, { content: "Bought a new bike", kind: "fact" });
    expect(buildSystemPrompt(user.id)).toBe(before);
  });

  it("includes the rolling conversation summary when one is passed", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-conv-summary"));
    const prompt = buildSystemPrompt(user.id, "The user mentioned their flight to Lisbon was delayed to 6pm.");
    expect(prompt).toContain("The user mentioned their flight to Lisbon was delayed to 6pm.");
  });

  it("omits any conversation-summary framing when none is passed", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-conv-summary-absent"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("Earlier in this conversation");
  });
});

describe("runTool defense-in-depth", () => {
  it("rejects a teams tool call when teams is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-teams"));
    const result = await runTool(user.id, "list_recent_chats", {});
    expect(result).toEqual({ error: "tool not enabled: list_recent_chats" });
  });

  it("rejects a travel tool call when travel is not enabled for that owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-travel"));
    const result = await runTool(user.id, "count_travel_days", { area: "schengen" });
    expect(result).toEqual({ error: "tool not enabled: count_travel_days" });
  });

  it("does not block always-on tools regardless of enabled-tools state", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("defense-remember"));
    const result = await runTool(user.id, "remember", { note: "test note" });
    expect(result).toEqual({ ok: true });
  });
});

// Regression coverage for a real bug: calendar events for something outside the user's home
// timezone (a flight, a trip abroad) always ended up in the user's home timezone instead of the
// event's real local time. See providers/google.calendarEvent.test.ts and
// microsoft.calendarEvent.test.ts for the provider-level fix — this covers that runTool actually
// threads the tool's start_timezone/end_timezone input through to hubCreateEvent/hubUpdateEvent
// as EventInput's startTimeZone/endTimeZone.
describe("create_calendar_event / update_calendar_event — timezone passthrough", () => {
  beforeEach(() => {
    mockHubCreateEvent.mockReset().mockResolvedValue({ id: "evt-1" });
    mockHubUpdateEvent.mockReset().mockResolvedValue({ id: "evt-1" });
  });

  it("threads start_timezone/end_timezone into hubCreateEvent's EventInput", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("event-tz-create"));

    await runTool(user.id, "create_calendar_event", {
      account_id: 1,
      title: "Flight to Lima",
      start: "2026-09-19T17:29:00",
      end: "2026-09-19T20:35:00",
      start_timezone: "America/Bogota",
      end_timezone: "America/Lima",
    });

    expect(mockHubCreateEvent).toHaveBeenCalledWith(
      user.id,
      1,
      expect.objectContaining({ startTimeZone: "America/Bogota", endTimeZone: "America/Lima" })
    );
  });

  it("passes undefined timezones through when the model omits them (ordinary home-timezone event)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("event-tz-create-omitted"));

    await runTool(user.id, "create_calendar_event", {
      account_id: 1,
      title: "Dentist",
      start: "2026-09-19T09:00:00Z",
      end: "2026-09-19T09:30:00Z",
    });

    expect(mockHubCreateEvent).toHaveBeenCalledWith(
      user.id,
      1,
      expect.objectContaining({ startTimeZone: undefined, endTimeZone: undefined })
    );
  });

  it("threads start_timezone/end_timezone into hubUpdateEvent's EventInput too", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("event-tz-update"));

    await runTool(user.id, "update_calendar_event", {
      account_id: 1,
      event_id: "evt-1",
      start: "2026-09-19T18:00:00",
      end: "2026-09-19T21:00:00",
      start_timezone: "America/Bogota",
      end_timezone: "America/Lima",
    });

    expect(mockHubUpdateEvent).toHaveBeenCalledWith(
      user.id,
      1,
      "evt-1",
      expect.objectContaining({ startTimeZone: "America/Bogota", endTimeZone: "America/Lima" })
    );
  });
});

describe("flag_unmet_request tool", () => {
  it("logs a web-channel unmet request when no phone is passed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unmet-web"));
    const result = await runTool(user.id, "flag_unmet_request", {
      summary: "Wanted Marlowe to book a flight — no booking capability exists",
    });
    expect(result).toEqual({ ok: true });
    const logged = listUnmetRequests(true).find((r) => r.ownerId === user.id);
    expect(logged?.channel).toBe("web");
    expect(logged?.summary).toBe("Wanted Marlowe to book a flight — no booking capability exists");
  });

  it("logs a whatsapp-channel unmet request when a phone is passed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unmet-whatsapp"));
    await runTool(user.id, "flag_unmet_request", { summary: "Asked to pay an invoice directly" }, "447700900000");
    const logged = listUnmetRequests(true).find((r) => r.ownerId === user.id);
    expect(logged?.channel).toBe("whatsapp");
  });
});

describe("set_briefing_preferences tool", () => {
  it("merges a patch onto a user's existing briefing settings", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("briefing-merge"));
    const existing: BriefingSettings = {
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
    saveBriefingSettings(user.id, existing);

    const result = await runTool(user.id, "set_briefing_preferences", {
      include_weather: true,
      weather_location: "Lisbon",
      include_news: true,
      topics: ["technology", "business"],
      send_time: "08:00",
    });

    expect(result).toEqual({ ok: true });
    const saved = getBriefingSettings(user.id);
    expect(saved.includeWeather).toBe(true);
    expect(saved.weatherLocation).toBe("Lisbon");
    expect(saved.includeNews).toBe(true);
    expect(saved.topics).toEqual(["technology", "business"]);
    expect(saved.sendTime).toBe("08:00");
    // Untouched fields keep their prior value — this is a patch, not a replace.
    expect(saved.includeMarkets).toBe(false);
  });

  it("silently drops unrecognized news topics instead of erroring", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("briefing-bad-topic"));
    const result = await runTool(user.id, "set_briefing_preferences", {
      include_news: true,
      topics: ["technology", "not_a_real_topic"],
    });
    expect(result).toEqual({ ok: true });
    expect(getBriefingSettings(user.id).topics).toEqual(["technology"]);
  });
});

describe("set_email_alerts tool", () => {
  it("turns off only real-person alerts when that's all the user asked", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-people"));
    const result = await runTool(user.id, "set_email_alerts", { people: false });
    expect(result).toEqual({
      ok: true,
      people: false,
      important: true,
      people_mode: "digest",
      digest_time: "21:00",
    });
    expect(realPersonAlertsEnabled(user.id)).toBe(false);
    expect(importantEmailAlertsEnabled(user.id)).toBe(true);
  });

  it("opts into an instant ping per email, without touching important-email pings", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-instant"));
    const result = await runTool(user.id, "set_email_alerts", { people_mode: "instant" });
    expect(result).toEqual({
      ok: true,
      people: true,
      important: true,
      people_mode: "instant",
      digest_time: "21:00",
    });
    expect(realPersonAlertMode(user.id)).toBe("instant");
  });

  it("answering the first-digest check-in in words retires its buttons, so a later tap can't undo it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-answer-retires-buttons"));
    const actionId = createPendingAction(user.id, "email_digest", "Keep the daily email summary?", "{}");
    await runTool(user.id, "set_email_alerts", { people_mode: "instant" });
    expect(consumePendingAction(actionId, user.id)).toBeNull();
  });

  it("changing something unrelated leaves an open check-in alone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-unrelated-keeps-buttons"));
    const actionId = createPendingAction(user.id, "email_digest", "Keep the daily email summary?", "{}");
    await runTool(user.id, "set_email_alerts", { important: false });
    expect(consumePendingAction(actionId, user.id)).not.toBeNull();
  });

  it("sets the digest time", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-digest"));
    const result = await runTool(user.id, "set_email_alerts", { people_mode: "digest", digest_time: "20:30" });
    expect(result).toMatchObject({ people_mode: "digest", digest_time: "20:30" });
    expect(emailDigestTime(user.id)).toBe("20:30");
  });

  it("asking for a digest switches real-person emails back on if they were off", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-digest-reenable"));
    await runTool(user.id, "set_email_alerts", { people: false });
    const result = await runTool(user.id, "set_email_alerts", { people_mode: "digest" });
    expect(result).toMatchObject({ people: true, people_mode: "digest" });
  });

  it("can change just the digest time, and go back to instant", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-digest-time"));
    expect(await runTool(user.id, "set_email_alerts", { digest_time: "19:00" })).toMatchObject({
      people_mode: "digest",
      digest_time: "19:00",
    });
    await runTool(user.id, "set_email_alerts", { people_mode: "instant" });
    expect(await runTool(user.id, "set_email_alerts", { people_mode: "digest" })).toMatchObject({
      people_mode: "digest",
    });
  });

  it("rejects an unknown mode or a malformed digest time without changing anything", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-digest-bad"));
    expect(await runTool(user.id, "set_email_alerts", { people_mode: "hourly" })).toHaveProperty("error");
    expect(await runTool(user.id, "set_email_alerts", { digest_time: "9pm" })).toHaveProperty("error");
    expect(realPersonAlertMode(user.id)).toBe("digest");
    expect(emailDigestTime(user.id)).toBe("21:00");
  });

  it("turns off both when the user wants no email pings at all, and back on again", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-all"));
    expect(await runTool(user.id, "set_email_alerts", { people: false, important: false })).toMatchObject({
      ok: true,
      people: false,
      important: false,
    });
    expect(await runTool(user.id, "set_email_alerts", { people: true })).toMatchObject({
      ok: true,
      people: true,
      important: false,
    });
  });

  it("refuses a call that changes nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("email-alerts-empty"));
    expect(await runTool(user.id, "set_email_alerts", {})).toHaveProperty("error");
  });
});

describe("set_tool_enabled tool", () => {
  it("enables a tool for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("enable-via-tool"));
    const result = await runTool(user.id, "set_tool_enabled", { tool: "teams", enabled: true });
    expect(result).toEqual({ ok: true });
    expect(getEnabledTools(user.id)).toEqual(new Set(["teams"]));
  });

  it("disables a tool for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("disable-via-tool"));
    setToolEnabled(user.id, "travel", true);
    const result = await runTool(user.id, "set_tool_enabled", { tool: "travel", enabled: false });
    expect(result).toEqual({ ok: true });
    expect(getEnabledTools(user.id)).toEqual(new Set());
  });

  it("returns an error object (not a throw) for an unknown tool key", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("unknown-tool-key"));
    const result = await runTool(user.id, "set_tool_enabled", { tool: "finance", enabled: true });
    expect(result).toEqual({ error: "unknown tool: finance" });
  });
});

describe("connect_xero tool", () => {
  it("saves a valid forwarding address for the calling owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("connect-xero"));
    const result = await runTool(user.id, "connect_xero", { forwarding_email: "abc123@bills.xero.com" });
    expect(result).toEqual({ ok: true });
    expect(getXeroForwardingEmail(user.id)).toBe("abc123@bills.xero.com");
  });

  it("returns an error object (not a throw) for a malformed address, and saves nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("connect-xero-bad"));
    const result = await runTool(user.id, "connect_xero", { forwarding_email: "not-an-email" });
    expect(result).toEqual({ error: '"not-an-email" doesn\'t look like a valid email address.' });
    expect(getXeroForwardingEmail(user.id)).toBeNull();
  });
});

describe("buildSystemPrompt Xero status", () => {
  it("reports not connected when no address is saved", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-xero-off"));
    expect(buildSystemPrompt(user.id)).toContain("Xero: not connected");
  });

  it("reports the saved address once connected", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-xero-on"));
    await runTool(user.id, "connect_xero", { forwarding_email: "xyz789@bills.xero.com" });
    expect(buildSystemPrompt(user.id)).toContain("xyz789@bills.xero.com");
  });

  it("always describes both the WhatsApp and email paths, even with nothing pending", () => {
    // Regression test: with no pending confirmation, the model previously had zero standing
    // knowledge that email scanning exists at all (only the WhatsApp rule was permanent), and
    // told a user asking about an email invoice that Xero forwarding "only fires for receipts
    // sent via WhatsApp" — a hallucinated capability boundary born from the information gap,
    // not the model just guessing badly. This must hold with no pending invoice confirmation.
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-xero-two-paths"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("TWO separate paths to Xero");
    expect(prompt).toContain("does NOT mean email invoices are unsupported");
    expect(prompt).not.toContain("Pending Xero invoice confirmation");
  });
});

describe("buildSystemPrompt web_search guidance", () => {
  it("tells the model when to use web_search and how to present a place recommendation", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("web-search-rule"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("web_search");
    expect(prompt).toContain("google.com/maps/search");
  });
});

describe("remember tool — no longer schedules anything", () => {
  it("ignores a triggerAt-shaped field — remember is fact-only now", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-notrigger"));
    const result = await runTool(user.id, "remember", { note: "Ordinary preference", triggerAt: "2026-09-12T00:00:00Z" });
    expect(result).toEqual({ ok: true });

    const [saved] = listMemoryNotes(user.id);
    expect(saved.triggerAt).toBeNull();
  });
});

// The test database keeps phone numbers between runs, and a number belongs to one account only.
function randomUkMobile(): string {
  return `447911${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
}

describe("set_reminder tool", () => {
  it("is always available, same as remember", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-available"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("set_reminder");
  });

  it("schedules a one-shot reminder from relative_minutes with no timezone needed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-once-relative"));
    const before = Date.now();
    const result = (await runTool(user.id, "set_reminder", {
      message: "Check the oven",
      mode: "once",
      relative_minutes: 20,
    })) as { ok: true; reminder_id: number; next_fire_at: number };

    expect(result.ok).toBe(true);
    expect(result.next_fire_at).toBeGreaterThanOrEqual(before + 20 * 60_000);
    const [reminder] = listActiveRemindersForOwner(user.id);
    expect(reminder.message).toBe("Check the oven");
    expect(reminder.mode).toBe("once");
  });

  it("refuses a local_time reminder until the user's timezone is known", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-no-tz"));
    const result = (await runTool(user.id, "set_reminder", {
      message: "Call the bank",
      mode: "once",
      local_time: "15:00",
    })) as { error: string };

    expect(result.error).toMatch(/timezone/i);
    expect(listActiveRemindersForOwner(user.id)).toHaveLength(0);
  });

  it("schedules a local_time reminder once a timezone is on file", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-with-tz"));
    setUserTimezone(user.id, "Europe/London");
    const result = (await runTool(user.id, "set_reminder", {
      message: "Call the bank",
      mode: "once",
      local_time: "15:00",
    })) as { ok: true };

    expect(result.ok).toBe(true);
    expect(listActiveRemindersForOwner(user.id)).toHaveLength(1);
  });

  it("uses a timezone guessed from the phone number, and says which zone it assumed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-guessed-tz"));
    addPhoneNumberForUser(user.id, randomUkMobile());
    const result = (await runTool(user.id, "set_reminder", {
      message: "Call the bank",
      mode: "once",
      local_time: "15:00",
    })) as { ok: true; timezone_note?: string };

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result, JSON.stringify(result)).toHaveProperty("timezone_note");
    expect(result.timezone_note).toContain("Europe/London");
    expect(result.timezone_note).toMatch(/share their location/);
  });

  it("adds no timezone note once the zone is confirmed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-confirmed-tz"));
    addPhoneNumberForUser(user.id, randomUkMobile());
    setUserTimezone(user.id, "Europe/London");
    const result = (await runTool(user.id, "set_reminder", {
      message: "Call the bank",
      mode: "once",
      local_time: "15:00",
    })) as { ok: true; timezone_note?: string };
    expect(result.timezone_note).toBeUndefined();
  });

  it("schedules an interval reminder with a window", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-interval"));
    setUserTimezone(user.id, "Europe/London");
    const result = (await runTool(user.id, "set_reminder", {
      message: "Stretch",
      mode: "interval",
      local_time: "10:00",
      window_end_local_time: "10:30",
      interval_minutes: 5,
    })) as { ok: true };

    expect(result.ok).toBe(true);
    const [reminder] = listActiveRemindersForOwner(user.id);
    expect(reminder.mode).toBe("interval");
  });

  it("schedules an until_reply reminder with no timezone needed", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-until-reply"));
    const result = (await runTool(user.id, "set_reminder", {
      message: "Take your medicine",
      mode: "until_reply",
      interval_minutes: 1,
    })) as { ok: true };

    expect(result.ok).toBe(true);
    const [reminder] = listActiveRemindersForOwner(user.id);
    expect(reminder.mode).toBe("until_reply");
  });

  it("surfaces a ReminderTimeError as a tool error instead of throwing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-bad-time"));
    const result = (await runTool(user.id, "set_reminder", {
      message: "Bad",
      mode: "once",
      relative_minutes: -5,
    })) as { error: string };

    expect(result.error).toMatch(/positive/i);
  });
});

describe("get_current_time tool", () => {
  it("is always available, same as remember", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("time-available"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("get_current_time");
  });

  it("refuses until the user's timezone is known, same as set_reminder", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("time-no-tz"));
    const result = (await runTool(user.id, "get_current_time", {})) as { error: string };
    expect(result.error).toMatch(/timezone/i);
  });

  it("flags a zone that's only guessed from the phone number", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("time-guessed-tz"));
    addPhoneNumberForUser(user.id, randomUkMobile());
    const result = (await runTool(user.id, "get_current_time", {})) as { timezone: string; timezone_note?: string };
    expect(result.timezone).toBe("Europe/London");
    expect(result.timezone_note).toContain("assumed from their phone number");
  });

  it("reports the current time in the user's set timezone once known", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("time-with-tz"));
    setUserTimezone(user.id, "Europe/London");

    const result = (await runTool(user.id, "get_current_time", {})) as {
      timezone: string;
      current_time: string;
    };
    expect(result.timezone).toBe("Europe/London");
    expect(result.current_time).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });
});

describe("list_active_reminders / cancel_reminder tools", () => {
  it("lists a scheduled reminder and lets it be cancelled", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-list-cancel"));
    const { reminder_id } = (await runTool(user.id, "set_reminder", {
      message: "Ping me",
      mode: "once",
      relative_minutes: 5,
    })) as { reminder_id: number };

    const listed = (await runTool(user.id, "list_active_reminders", {})) as { reminder_id: number }[];
    expect(listed.map((r) => r.reminder_id)).toContain(reminder_id);

    const cancelled = await runTool(user.id, "cancel_reminder", { reminder_id });
    expect(cancelled).toEqual({ ok: true });
    expect(listActiveRemindersForOwner(user.id)).toHaveLength(0);
  });

  it("reports an error cancelling a reminder that doesn't belong to this owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-cancel-wrong-owner"));
    const result = (await runTool(user.id, "cancel_reminder", { reminder_id: 999_999 })) as { error: string };
    expect(result.error).toBeDefined();
  });
});

describe("remember tool — entity linking", () => {
  it("without entity_name/entity_type: behaves exactly as before, no entity created", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-no-entity"));
    const result = await runTool(user.id, "remember", { note: "Prefers window seats" });
    expect(result).toEqual({ ok: true });
    expect(findEntityByName(user.id, "Prefers window seats")).toBeNull();
    const [saved] = listMemoryNotes(user.id);
    expect(saved.content).toBe("Prefers window seats");
  });

  it("with entity_name+entity_type: creates the entity and files the note onto it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-new-entity"));
    const result = await runTool(user.id, "remember", {
      note: "Handles invoicing",
      entity_name: "Sarah",
      entity_type: "person",
    });
    expect(result).toEqual({ ok: true });

    const entity = findEntityByName(user.id, "Sarah", "person");
    expect(listActiveFactsForEntity(user.id, entity!.id).map((f) => f.content)).toEqual(["Handles invoicing"]);
    // One row, not two: the fact itself carries the entity.
    expect(listMemoryNotes(user.id).map((n) => n.content)).toEqual(["Handles invoicing"]);
  });

  it("a second remember call for the same name appends onto the same entity", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-append-entity"));
    await runTool(user.id, "remember", {
      note: "Handles invoicing",
      entity_name: "Sarah",
      entity_type: "person",
    });
    await runTool(user.id, "remember", {
      note: "Prefers email over calls",
      entity_name: "sarah",
      entity_type: "person",
    });

    const entity = findEntityByName(user.id, "Sarah", "person");
    expect(listActiveFactsForEntity(user.id, entity!.id).map((f) => f.content)).toEqual([
      "Prefers email over calls",
      "Handles invoicing",
    ]);
  });

  it("relates_to links to an existing entity by name", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relates-to"));
    await runTool(user.id, "remember", {
      note: "Kickoff is next week",
      entity_name: "Project Falcon",
      entity_type: "project",
    });
    await runTool(user.id, "remember", {
      note: "Leads Project Falcon",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Project Falcon"],
    });

    const sarah = findEntityByName(user.id, "Sarah", "person");
    const related = getRelatedEntities(user.id, { type: "entity", id: sarah!.id });
    expect(related.map((e) => e.data.name)).toEqual(["Project Falcon"]);
  });

  it("relates_to silently ignores a name with no match — no error, nothing created", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relates-to-miss"));
    const result = await runTool(user.id, "remember", {
      note: "Leads a project",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Nonexistent Project"],
    });
    expect(result).toEqual({ ok: true });

    const sarah = findEntityByName(user.id, "Sarah", "person");
    expect(getRelatedEntities(user.id, { type: "entity", id: sarah!.id })).toEqual([]);
    expect(findEntityByName(user.id, "Nonexistent Project")).toBeNull();
  });

  it("relates_to never matches a non-remember entity, even one with a matching name", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relates-to-nonremember"));
    saveEntity(user.id, {
      type: "travel_checkin",
      data: { country: "France", city: "Paris", checkedInAt: Date.now() },
    });

    const result = await runTool(user.id, "remember", {
      note: "Loves French cuisine",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["France"],
    });
    expect(result).toEqual({ ok: true });

    const sarah = findEntityByName(user.id, "Sarah", "person");
    expect(getRelatedEntities(user.id, { type: "entity", id: sarah!.id })).toEqual([]);
  });

  it("calling remember twice with the same entity_name/entity_type/relates_to does not duplicate links", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relates-to-dedupe"));
    await runTool(user.id, "remember", {
      note: "Kickoff is next week",
      entity_name: "Project Falcon",
      entity_type: "project",
    });
    const call = {
      note: "Leads Project Falcon",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Project Falcon"],
    };
    await runTool(user.id, "remember", call);
    await runTool(user.id, "remember", call);

    const sarah = findEntityByName(user.id, "Sarah", "person");
    const related = getRelatedEntities(user.id, { type: "entity", id: sarah!.id });
    expect(related).toHaveLength(1);
    expect(related[0].data.name).toBe("Project Falcon");
  });

  it("entity_name without entity_type falls back to the flat-note-only path", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-entityname-only"));
    const result = await runTool(user.id, "remember", { note: "Prefers window seats", entity_name: "Sarah" });
    expect(result).toEqual({ ok: true });
    expect(findEntityByName(user.id, "Sarah")).toBeNull();
  });

  it("a reserved entity_type (owned by another pipeline) saves the note with no entity, instead of creating one", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-reserved-type"));
    const result = await runTool(user.id, "remember", {
      note: "Booked the Hilton for next week",
      entity_name: "Hilton",
      entity_type: "expense",
    });
    expect(result).toEqual({ ok: true });
    expect(findEntityByName(user.id, "Hilton")).toBeNull();
    const [saved] = listMemoryNotes(user.id);
    expect(saved.content).toBe("Booked the Hilton for next week");
    expect(saved.entityId).toBeNull();
  });
});

describe("recall_entity tool", () => {
  it("is always available, same as remember", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recall-entity-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("recall_entity");
  });

  it("returns the entity plus everything linked to it", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recall-entity-found"));
    await runTool(user.id, "remember", {
      note: "Kickoff is next week",
      entity_name: "Project Falcon",
      entity_type: "project",
    });
    await runTool(user.id, "remember", {
      note: "Leads Project Falcon",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Project Falcon"],
    });

    const result = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      entity: { name: string };
      facts: { content: string }[];
      related: { relation: string; entity: { name: string } }[];
    };
    expect(result.entity.name).toBe("Sarah");
    expect(result.facts.map((f) => f.content)).toEqual(["Leads Project Falcon"]);
    expect(result.related.map((r) => r.entity.name)).toEqual(["Project Falcon"]);
  });

  it("respects an optional entity_type filter", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recall-entity-type-filter"));
    await runTool(user.id, "remember", {
      note: "A city, not a person",
      entity_name: "Lisbon",
      entity_type: "place",
    });

    const wrongType = (await runTool(user.id, "recall_entity", {
      entity_name: "Lisbon",
      entity_type: "project",
    })) as { error: string };
    expect(wrongType.error).toContain("Lisbon");

    const rightType = (await runTool(user.id, "recall_entity", {
      entity_name: "Lisbon",
      entity_type: "place",
    })) as { entity: { name: string } };
    expect(rightType.entity.name).toBe("Lisbon");
  });

  it("returns an error object (not a throw) when nothing matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recall-entity-miss"));
    const result = await runTool(user.id, "recall_entity", { entity_name: "Nobody" });
    expect(result).toEqual({ error: 'no entity found matching "Nobody"' });
  });

  it("finds a genuinely remembered entity without throwing or false-matching a non-remember entity present for the same owner", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("recall-entity-mixed-owner"));
    saveEntity(user.id, {
      type: "booking",
      data: { kind: "hotel", name: "Hotel Eva", reference: "ABC", startDate: "2026-01-01", endDate: null },
    });
    await runTool(user.id, "remember", {
      note: "Handles invoicing",
      entity_name: "Sarah",
      entity_type: "person",
    });

    const hit = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      entity: { name: string };
      facts: { content: string }[];
    };
    expect(hit.entity.name).toBe("Sarah");
    expect(hit.facts.map((f) => f.content)).toEqual(["Handles invoicing"]);

    const miss = await runTool(user.id, "recall_entity", { entity_name: "Hotel Eva" });
    expect(miss).toEqual({ error: 'no entity found matching "Hotel Eva"' });
  });
});

describe("remember + recall_entity end-to-end", () => {
  it("remembers an entity across multiple notes and calls, resolves relates_to, and recalls both notes plus the related entity", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-recall-e2e"));

    await runTool(user.id, "remember", {
      note: "Handles invoicing",
      entity_name: "Sarah",
      entity_type: "person",
    });
    await runTool(user.id, "remember", {
      note: "Prefers email over calls",
      entity_name: "Sarah",
      entity_type: "person",
    });
    await runTool(user.id, "remember", {
      note: "Kickoff is next week",
      entity_name: "Project Falcon",
      entity_type: "project",
      relates_to: ["Sarah"],
    });

    const result = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      entity: { name: string };
      facts: { content: string }[];
      related: { relation: string; entity: { name: string } }[];
    };
    expect(result.entity.name).toBe("Sarah");
    expect(result.facts.map((f) => f.content)).toEqual([
      "Prefers email over calls",
      "Handles invoicing",
    ]);
    expect(result.related.map((r) => r.entity.name)).toEqual(["Project Falcon"]);
  });
});

describe("list_flagged_emails tool", () => {
  it("is always available, same as recall_entity", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("flagged-emails-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("list_flagged_emails");
  });

  it("returns previously flagged emails newest first", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("flagged-emails-list"));
    saveEntity(user.id, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: 1,
        accountEmail: "me@example.com",
        messageId: "msg-1",
        category: "invoice_due",
        subject: "Invoice from Acme",
        from: "billing@acme.com",
        summary: "£120 due 1 Sep.",
        receivedAt: "2026-09-01T00:00:00.000Z",
      },
    });
    saveEntity(user.id, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: 1,
        accountEmail: "me@example.com",
        messageId: "msg-2",
        category: "flight_change",
        subject: "Your flight changed",
        from: "no-reply@delta.com",
        summary: "Your gate moved to B12.",
        receivedAt: "2026-09-02T00:00:00.000Z",
      },
    });

    const result = (await runTool(user.id, "list_flagged_emails", {})) as { subject: string }[];
    expect(result.map((r) => r.subject)).toEqual(["Your flight changed", "Invoice from Acme"]);
  });

  it("filters by category when given", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("flagged-emails-category"));
    saveEntity(user.id, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: 1,
        accountEmail: "me@example.com",
        messageId: "msg-1",
        category: "invoice_due",
        subject: "Invoice from Acme",
        from: "billing@acme.com",
        summary: "",
        receivedAt: "2026-09-01T00:00:00.000Z",
      },
    });
    saveEntity(user.id, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: 1,
        accountEmail: "me@example.com",
        messageId: "msg-2",
        category: "flight_change",
        subject: "Your flight changed",
        from: "no-reply@delta.com",
        summary: "",
        receivedAt: "2026-09-02T00:00:00.000Z",
      },
    });

    const result = (await runTool(user.id, "list_flagged_emails", {
      category: "invoice_due",
    })) as { subject: string }[];
    expect(result.map((r) => r.subject)).toEqual(["Invoice from Acme"]);
  });

  it("never leaks another owner's flagged emails", async () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("flagged-emails-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("flagged-emails-owner-b"));
    saveEntity(userA.id, {
      type: IMPORTANT_EMAIL_ENTITY_TYPE,
      data: {
        accountId: 1,
        accountEmail: "a@example.com",
        messageId: "msg-1",
        category: "invoice_due",
        subject: "Owner A's invoice",
        from: "billing@acme.com",
        summary: "",
        receivedAt: "2026-09-01T00:00:00.000Z",
      },
    });

    const result = await runTool(userB.id, "list_flagged_emails", {});
    expect(result).toEqual([]);
  });
});

describe("search_read_emails tool", () => {
  it("is always available, same as list_flagged_emails", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("search_read_emails");
  });

  it("finds a previously listed message with no body by subject", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-metadata-only"));
    upsertReadEmail(user.id, {
      accountId: 1,
      accountEmail: "me@example.com",
      id: "msg-1",
      subject: "Electrician quote",
      from: "quotes@electrician.co",
      snippet: "£450 for the rewiring job",
      receivedAt: "2026-09-01T00:00:00.000Z",
    });

    const result = (await runTool(user.id, "search_read_emails", { query: "electrician" })) as {
      subject: string;
      body: string | null;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe("Electrician quote");
    expect(result[0].body).toBeNull();
  });

  it("finds a previously opened message by its full body content", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("read-emails-body"));
    upsertReadEmail(user.id, {
      accountId: 1,
      accountEmail: "me@example.com",
      id: "msg-2",
      subject: "Your quote",
      from: "quotes@electrician.co",
      snippet: "",
      receivedAt: "2026-09-01T00:00:00.000Z",
      body: "Rewiring quote: £450, valid until 30 Sep.",
    });

    const result = (await runTool(user.id, "search_read_emails", { query: "valid until" })) as {
      body: string | null;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Rewiring quote: £450, valid until 30 Sep.");
  });

  it("never leaks another owner's cached emails", async () => {
    const userA = findOrCreateUserByEmail(uniqueEmail("read-emails-owner-a"));
    const userB = findOrCreateUserByEmail(uniqueEmail("read-emails-owner-b"));
    upsertReadEmail(userA.id, {
      accountId: 1,
      accountEmail: "a@example.com",
      id: "msg-1",
      subject: "Owner A's electrician quote",
      from: "quotes@electrician.co",
      snippet: "",
      receivedAt: "2026-09-01T00:00:00.000Z",
    });

    const result = await runTool(userB.id, "search_read_emails", { query: "electrician" });
    expect(result).toEqual([]);
  });
});

describe("buildSystemPrompt recall_entity guidance", () => {
  it("mentions recall_entity alongside the remember rule", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-recall-entity"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("recall_entity");
  });
});

describe("search_memory tool", () => {
  it("is always available, same as remember", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-memory-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("search_memory");
  });

  it("finds a remembered note outside runTool's own prompt-injection window", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-memory-basic"));
    await runTool(user.id, "remember", { note: "Allergic to shellfish" });
    await runTool(user.id, "remember", { note: "Prefers window seats on flights" });

    const results = (await runTool(user.id, "search_memory", { query: "shellfish" })) as {
      content: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Allergic to shellfish");
  });

  it("passes a caller-supplied limit through to the store", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-memory-limit"));
    await runTool(user.id, "remember", { note: "Trip note alpha" });
    await runTool(user.id, "remember", { note: "Trip note beta" });
    await runTool(user.id, "remember", { note: "Trip note gamma" });

    const results = (await runTool(user.id, "search_memory", { query: "trip", limit: 2 })) as unknown[];
    expect(results).toHaveLength(2);
  });
});

describe("remember — kind, replaces_id, relation", () => {
  it("files a core fact when kind is core", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-kind-core"));
    await runTool(user.id, "remember", { note: "The user's name is Sam", kind: "core" });
    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["The user's name is Sam"]);
  });

  it("an unknown kind falls back to fact", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-kind-bad"));
    await runTool(user.id, "remember", { note: "Something", kind: "banana" });
    expect(listMemoryNotes(user.id)[0].kind).toBe("fact");
  });

  it("replaces_id supersedes the old fact", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-replaces"));
    const old = addFact(user.id, { content: "Lives in Paris", kind: "core" });
    await runTool(user.id, "remember", { note: "Lives in London", kind: "core", replaces_id: old.id });
    expect(listCoreProfile(user.id).map((f) => f.content)).toEqual(["Lives in London"]);
  });

  it("replaces_id with another owner's fact id supersedes nothing", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("remember-replaces-owner"));
    const intruder = findOrCreateUserByEmail(uniqueEmail("remember-replaces-intruder"));
    const theirs = addFact(owner.id, { content: "Owner's fact" });
    await runTool(intruder.id, "remember", { note: "Mine", replaces_id: theirs.id });
    expect(listMemoryNotes(owner.id).map((f) => f.id)).toEqual([theirs.id]);
  });

  it("relation labels the relates_to links", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-relation"));
    await runTool(user.id, "remember", { note: "Acme is a client", entity_name: "Acme", entity_type: "organisation" });
    await runTool(user.id, "remember", {
      note: "Sarah works at Acme",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Acme"],
      relation: "works_at",
    });
    const result = (await runTool(user.id, "recall_entity", { entity_name: "Sarah" })) as {
      related: { relation: string; entity: { name: string } }[];
    };
    expect(result.related).toEqual([expect.objectContaining({ relation: "works_at", entity: expect.objectContaining({ name: "Acme" }) })]);
  });
});

describe("forget_memory tool", () => {
  it("is always available", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-toollist"));
    expect(buildToolsForOwner(user.id).map((t) => t.name)).toContain("forget_memory");
  });

  it("forgets this owner's facts and reports which ids", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forget-tool-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("forget-tool-other"));
    const mine = addFact(owner.id, { content: "Allergic to shellfish" });
    const theirs = addFact(other.id, { content: "Allergic to peanuts" });

    const result = await runTool(owner.id, "forget_memory", { ids: [mine.id, theirs.id] });

    expect(result).toEqual({ forgotten: [mine.id], forgotten_entities: [] });
    expect(searchMemoryNotes(owner.id, "shellfish")).toEqual([]);
    expect(listMemoryNotes(other.id)).toHaveLength(1);
  });

  it("tolerates missing or malformed inputs", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-tool-bad"));
    const empty = { forgotten: [], forgotten_entities: [] };
    expect(await runTool(user.id, "forget_memory", {})).toEqual(empty);
    expect(await runTool(user.id, "forget_memory", { ids: ["x", 1.5] })).toEqual(empty);
    expect(await runTool(user.id, "forget_memory", { entity_names: [42, "", "Nobody"] })).toEqual(empty);
  });

  it("does not require ids, now that entity_names is an alternative", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-tool-schema"));
    const tool = buildToolsForOwner(user.id).find((t) => t.name === "forget_memory")!;
    expect(tool.input_schema.required ?? []).not.toContain("ids");
    expect(Object.keys(tool.input_schema.properties as object)).toEqual(expect.arrayContaining(["ids", "entity_names"]));
  });

  it("forgets a whole entity: its facts, the entity and its links, reachable nowhere afterwards", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-entity"));
    await runTool(user.id, "remember", { note: "Acme is a client", entity_name: "Acme", entity_type: "organisation" });
    await runTool(user.id, "remember", {
      note: "Sarah handles invoicing at Acme",
      entity_name: "Sarah",
      entity_type: "person",
      relates_to: ["Acme"],
      relation: "works_at",
    });
    await runTool(user.id, "remember", { note: "Sarah prefers email", entity_name: "Sarah", entity_type: "person" });
    const sarah = findEntityByName(user.id, "Sarah")!;
    const acme = findEntityByName(user.id, "Acme")!;
    const sarahFactIds = listActiveFactsForEntity(user.id, sarah.id).map((f) => f.id);

    const result = (await runTool(user.id, "forget_memory", { entity_names: ["sarah"] })) as {
      forgotten: number[];
      forgotten_entities: string[];
    };

    expect(result.forgotten.sort()).toEqual(sarahFactIds.sort());
    expect(result.forgotten_entities).toEqual(["Sarah"]);
    expect(await runTool(user.id, "recall_entity", { entity_name: "Sarah" })).toEqual({
      error: 'no entity found matching "Sarah"',
    });
    expect(retrieveRelevantMemory(user.id, "email Sarah about invoicing") ?? "").not.toMatch(/Sarah/);
    expect(listEntityRelations(user.id, acme.id)).toEqual([]);
    expect(listMemoryNotes(user.id).map((f) => f.content)).toEqual(["Acme is a client"]);
  });

  it("combines ids and entity_names", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-both"));
    const loose = addFact(user.id, { content: "Likes jazz" });
    await runTool(user.id, "remember", { note: "Bob plays tennis", entity_name: "Bob", entity_type: "person" });
    const bobFact = listMemoryNotes(user.id).find((f) => f.content === "Bob plays tennis")!;

    expect(await runTool(user.id, "forget_memory", { ids: [loose.id], entity_names: ["Bob"] })).toEqual({
      forgotten: [loose.id, bobFact.id],
      forgotten_entities: ["Bob"],
    });
  });

  it("never touches another owner's entity of the same name", async () => {
    const owner = findOrCreateUserByEmail(uniqueEmail("forget-entity-owner"));
    const other = findOrCreateUserByEmail(uniqueEmail("forget-entity-other"));
    await runTool(owner.id, "remember", { note: "Sarah is my sister", entity_name: "Sarah", entity_type: "person" });
    await runTool(other.id, "remember", { note: "Sarah is my boss", entity_name: "Sarah", entity_type: "person" });

    await runTool(owner.id, "forget_memory", { entity_names: ["Sarah"] });

    expect(findEntityByName(owner.id, "Sarah")).toBeNull();
    const theirs = findEntityByName(other.id, "Sarah")!;
    expect(listActiveFactsForEntity(other.id, theirs.id).map((f) => f.content)).toEqual(["Sarah is my boss"]);
  });

  it("can never delete a document-extracted entity, which findEntityByName doesn't return", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("forget-entity-booking"));
    saveEntity(user.id, {
      type: "booking",
      data: { kind: "hotel", name: "Hotel Eva", reference: "ABC", startDate: "2026-01-01", endDate: null },
    });

    expect(await runTool(user.id, "forget_memory", { entity_names: ["Hotel Eva"] })).toEqual({
      forgotten: [],
      forgotten_entities: [],
    });
    expect(listEntities(user.id, { type: "booking" })).toHaveLength(1);
  });
});

describe("search_memory — ids, kinds, entity names, empty query", () => {
  it("returns id, content, kind and entity name", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-shape"));
    await runTool(user.id, "remember", { note: "Sarah handles invoicing", entity_name: "Sarah", entity_type: "person" });
    const results = (await runTool(user.id, "search_memory", { query: "invoicing" })) as unknown[];
    expect(results).toEqual([
      { id: expect.any(Number), content: "Sarah handles invoicing", kind: "fact", entity: "Sarah" },
    ]);
  });

  it("falls back to any-term matching when an all-terms search finds nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-fallback"));
    await runTool(user.id, "remember", { note: "Allergic to shellfish" });
    const results = (await runTool(user.id, "search_memory", { query: "shellfish lobster allergy" })) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(["Allergic to shellfish"]);
  });

  it("with no query returns the core profile plus newest other facts", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-empty"));
    await runTool(user.id, "remember", { note: "Name is Sam", kind: "core" });
    await runTool(user.id, "remember", { note: "Likes jazz", kind: "preference" });
    const results = (await runTool(user.id, "search_memory", {})) as { content: string }[];
    expect(results.map((r) => r.content)).toEqual(["Name is Sam", "Likes jazz"]);
  });
});

describe("check_reminder_status tool", () => {
  it("is always available, same as remember", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-status-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("check_reminder_status");
  });

  it("reports a scheduled reminder as active", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-status-scheduled"));
    await runTool(user.id, "set_reminder", {
      message: "Text Henry about the meeting",
      mode: "once",
      relative_minutes: 60,
    });

    const results = (await runTool(user.id, "check_reminder_status", { query: "Henry" })) as {
      message: string;
      status: string;
    }[];
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("Text Henry about the meeting");
    expect(results[0].status).toBe("active");
  });

  it("reports no results for a query matching nothing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-status-nomatch"));
    await runTool(user.id, "remember", { note: "Henry's allergy is shellfish" });

    const results = (await runTool(user.id, "check_reminder_status", { query: "Henry" })) as unknown[];
    expect(results).toHaveLength(0);
  });

  it("passes a caller-supplied limit through to the store", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-status-limit"));
    for (const suffix of ["alpha", "beta", "gamma"]) {
      await runTool(user.id, "set_reminder", {
        message: `Trip reminder ${suffix}`,
        mode: "once",
        relative_minutes: 10,
      });
    }

    const results = (await runTool(user.id, "check_reminder_status", {
      query: "trip",
      limit: 2,
    })) as unknown[];
    expect(results).toHaveLength(2);
  });

  it("reports a reminder that already fired as done", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("reminder-status-done"));
    const { reminder_id } = (await runTool(user.id, "set_reminder", {
      message: "Text Henry at 11am",
      mode: "once",
      relative_minutes: 60,
    })) as { reminder_id: number };
    await runTool(user.id, "cancel_reminder", { reminder_id });

    const results = (await runTool(user.id, "check_reminder_status", { query: "Henry" })) as {
      status: string;
    }[];
    expect(results[0].status).toBe("cancelled");
  });
});

describe("buildSystemPrompt onboarding paragraph", () => {
  it("is present, without mentioning set_briefing_preferences, while ask_first_task is pending", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-first-task"));
    setPendingSetup(user.id, "ask_first_task");
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("mid-setup");
    expect(prompt).not.toContain("set_briefing_preferences");
  });

  it("is absent once the post-connect chain isn't pending, even for a user with no saved briefing settings", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-off"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("set_briefing_preferences");
    expect(prompt).not.toContain("mid-setup");
  });

  it("is absent for ask_briefing/ask_teams (the button-only steps)", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-buttons"));
    setPendingSetup(user.id, "ask_briefing");
    expect(buildSystemPrompt(user.id)).not.toContain("mid-setup");
  });
});

describe("messageForModel", () => {
  const BASE: UnifiedMessage = {
    id: "m1",
    accountId: 2,
    accountEmail: "a@example.com",
    provider: "google",
    subject: "Your ticket",
    from: "airline@example.com",
    snippet: "...",
    receivedAt: "2026-08-01T00:00:00.000Z",
    unread: false,
    link: "https://mail.example.com/m1",
  };

  it("replaces each attachment's raw id with a 1-based index and drops other id-adjacent fields", () => {
    const out = messageForModel({
      ...BASE,
      attachments: [
        { id: "a-very-long-opaque-provider-token-1", filename: "ticket.pdf", mimeType: "application/pdf", size: 1234 },
        { id: "a-very-long-opaque-provider-token-2", filename: "receipt.pdf", mimeType: "application/pdf", size: 456 },
      ],
    }) as { attachments: Array<Record<string, unknown>> };

    expect(out.attachments).toEqual([
      { index: 1, filename: "ticket.pdf", mimeType: "application/pdf", size: 1234 },
      { index: 2, filename: "receipt.pdf", mimeType: "application/pdf", size: 456 },
    ]);
    expect(JSON.stringify(out)).not.toContain("a-very-long-opaque-provider-token");
  });

  it("passes a message with no attachments through untouched", () => {
    expect(messageForModel({ ...BASE })).toEqual(BASE);
  });

  it("passes null through untouched", () => {
    expect(messageForModel(null)).toBeNull();
  });
});

describe("trimSnippetForList", () => {
  const BASE: UnifiedMessage = {
    id: "m1",
    accountId: 2,
    accountEmail: "a@example.com",
    provider: "google",
    subject: "Your ticket",
    from: "airline@example.com",
    snippet: "short preview",
    receivedAt: "2026-08-01T00:00:00.000Z",
    unread: false,
    link: "https://mail.example.com/m1",
  };

  it("leaves a snippet at or under 150 chars untouched", () => {
    expect(trimSnippetForList(BASE)).toEqual(BASE);
  });

  it("truncates a snippet over 150 chars to 150 chars plus an ellipsis, leaving other fields untouched", () => {
    const longSnippet = "x".repeat(300);
    const out = trimSnippetForList({ ...BASE, snippet: longSnippet });

    expect(out.snippet).toBe("x".repeat(150) + "…");
    expect(out).toEqual({ ...BASE, snippet: "x".repeat(150) + "…" });
  });
});

describe("extract_email_attachment dispatch", () => {
  beforeEach(() => {
    mockIngestEmailAttachment.mockReset();
  });

  it("passes account_id/message_id/attachment_index through and forwards a success result", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("extract-attachment-ok"));
    mockIngestEmailAttachment.mockResolvedValue({
      ok: true,
      alreadyExtracted: false,
      doc: { id: 1, title: "Ipanema Hostel Booking", storedPath: "/tmp/x" },
    });

    const result = await runTool(user.id, "extract_email_attachment", {
      account_id: 2,
      message_id: "msg-1",
      attachment_index: 1,
    });

    expect(mockIngestEmailAttachment).toHaveBeenCalledWith({
      ownerId: user.id,
      accountId: 2,
      messageId: "msg-1",
      attachmentIndex: 1,
    });
    expect(result).toEqual({ id: 1, title: "Ipanema Hostel Booking", alreadyExtracted: false });
  });

  it("surfaces a clear error when the attachment can't be downloaded", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("extract-attachment-fail"));
    mockIngestEmailAttachment.mockResolvedValue({ ok: false, reason: "unavailable" });

    const result = await runTool(user.id, "extract_email_attachment", {
      account_id: 2,
      message_id: "msg-1",
      attachment_index: 2,
    });

    expect(result).toEqual({ error: expect.stringContaining("Couldn't download") });
  });

  it("surfaces a specific error when the attachment index doesn't match the message", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("extract-attachment-bad-index"));
    mockIngestEmailAttachment.mockResolvedValue({ ok: false, reason: "invalid_index" });

    const result = await runTool(user.id, "extract_email_attachment", {
      account_id: 2,
      message_id: "msg-1",
      attachment_index: 9,
    });

    expect(result).toEqual({ error: expect.stringContaining("index") });
  });
});

describe("send_document dispatch", () => {
  beforeEach(() => {
    mockSendSavedDocumentFile.mockReset();
  });

  it("refuses without a phone (web chat/eval callers) before calling sendSavedDocumentFile", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-no-phone"));

    const result = await runTool(user.id, "send_document", { document_id: 1 });

    expect(result).toEqual({ error: expect.stringContaining("WhatsApp conversation") });
    expect(mockSendSavedDocumentFile).not.toHaveBeenCalled();
  });

  it("passes ownerId/phone/document_id through and reports success", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-ok"));
    mockSendSavedDocumentFile.mockResolvedValue({ ok: true });

    const result = await runTool(user.id, "send_document", { document_id: 42 }, "447000000001");

    expect(mockSendSavedDocumentFile).toHaveBeenCalledWith(user.id, "447000000001", 42);
    expect(result).toEqual({ ok: true });
  });

  it("surfaces a specific error when there's no original file to send", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("send-doc-no-original"));
    mockSendSavedDocumentFile.mockResolvedValue({ ok: false, reason: "no_original_file" });

    const result = await runTool(user.id, "send_document", { document_id: 7 }, "447000000001");

    expect(result).toEqual({ error: expect.stringContaining("no original photo") });
  });
});

describe("search_conversation_history tool", () => {
  it("is always available, same as send_document", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-toollist"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("search_conversation_history");
  });

  it("refuses without a phone (web chat/eval callers)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-no-phone"));

    const result = await runTool(user.id, "search_conversation_history", { query: "passport" });

    expect(result).toEqual({ error: expect.stringContaining("WhatsApp conversation") });
  });

  it("finds an older message outside the visible window, scoped to the calling phone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-hit"));
    const phone = "447700000123";
    // Seed directly via the store's own append path used by the WhatsApp route, not runTool —
    // there's no "send a WhatsApp message" tool; messages land in the table via the webhook.
    appendWhatsAppMessage(user.id, phone, "user", "My passport number is X1234567");

    const result = (await runTool(user.id, "search_conversation_history", { query: "passport" }, phone)) as unknown[];

    expect(result).toHaveLength(1);
  });

  it("returns an empty array, not an error, when nothing matches", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-miss"));
    const phone = "447700000124";

    const result = await runTool(user.id, "search_conversation_history", { query: "nonexistent-topic" }, phone);

    expect(result).toEqual([]);
  });

  it("misses a message under AND semantics when the query is a full natural-language sentence (known, tested contract, not a bug)", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-and-semantics"));
    const phone = "447700000125";
    appendWhatsAppMessage(user.id, phone, "user", "My sister's passport is in the blue drawer");

    // Every extracted term must appear in the same message, so a realistic multi-word question
    // built from the same facts doesn't match — the message doesn't contain "what", "did", "I",
    // "say", or "about" together with the rest. This documents the current AND behavior; it is
    // not something a prompt-only fix can change.
    const result = await runTool(
      user.id,
      "search_conversation_history",
      { query: "what did I say about my sister's passport" },
      phone
    );

    expect(result).toEqual([]);
  });

  it("clamps an out-of-range model-supplied limit instead of returning the whole matching transcript", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("search-history-limit-clamp"));
    const phone = "447700000126";
    for (let i = 0; i < 60; i++) {
      appendWhatsAppMessage(user.id, phone, "user", `passport note number ${i}`);
    }

    const result = (await runTool(
      user.id,
      "search_conversation_history",
      { query: "passport", limit: 9999 },
      phone
    )) as unknown[];

    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("respond_to_invoice_forward_prompt tool", () => {
  beforeEach(() => {
    mockIngestEmailAttachment.mockReset();
    mockIngestEmailBodyReceipt.mockReset();
    mockHubGetMessage.mockReset();
  });

  it("errors without throwing when there is nothing pending", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-none"));
    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: true });
    expect(result).toEqual({ error: expect.stringContaining("No pending invoice confirmation") });
  });

  it("clears pending state without forwarding when declined", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-decline"));
    setPendingInvoiceForward(user.id, { accountId: 1, messageId: "m1", subject: "Invoice from Acme" });

    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: false });

    expect(result).toEqual({ ok: true, forwarded: false });
    expect(mockHubGetMessage).not.toHaveBeenCalled();
    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("extracts every attachment on the pending message when confirmed, then clears pending state", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-yes"));
    setPendingInvoiceForward(user.id, { accountId: 5, messageId: "m1", subject: "Invoice from Acme" });
    mockHubGetMessage.mockResolvedValue({
      attachments: [
        { id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", size: 100 },
        { id: "att-2", filename: "terms.pdf", mimeType: "application/pdf", size: 50 },
      ],
    });
    mockIngestEmailAttachment.mockResolvedValue({ ok: true, alreadyExtracted: false, doc: { id: 1 } });

    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: true });

    expect(mockHubGetMessage).toHaveBeenCalledWith(user.id, 5, "m1");
    expect(mockIngestEmailAttachment).toHaveBeenCalledTimes(2);
    expect(mockIngestEmailAttachment).toHaveBeenCalledWith({
      ownerId: user.id,
      accountId: 5,
      messageId: "m1",
      attachmentIndex: 1,
    });
    expect(result).toEqual({ ok: true, forwarded: true, attachmentsProcessed: 2 });
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("errors when the pending message no longer has an attachment or a body", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-gone"));
    setPendingInvoiceForward(user.id, { accountId: 1, messageId: "m1", subject: "Invoice from Acme" });
    mockHubGetMessage.mockResolvedValue({ attachments: [] });

    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: true });

    expect(result).toEqual({ error: expect.stringContaining("Couldn't find that email anymore") });
    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(mockIngestEmailBodyReceipt).not.toHaveBeenCalled();
  });

  it("extracts from the email body when confirmed and there's no attachment, then clears pending state", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-body-yes"));
    setPendingInvoiceForward(user.id, { accountId: 5, messageId: "m1", subject: "Your receipt" });
    mockHubGetMessage.mockResolvedValue({ attachments: [], body: "Thanks for your payment of £22.80." });
    mockIngestEmailBodyReceipt.mockResolvedValue({ ok: true, doc: { id: 1 } });

    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: true });

    expect(mockIngestEmailAttachment).not.toHaveBeenCalled();
    expect(mockIngestEmailBodyReceipt).toHaveBeenCalledWith({
      ownerId: user.id,
      accountId: 5,
      messageId: "m1",
      subject: "Your receipt",
      bodyText: "Thanks for your payment of £22.80.",
    });
    expect(result).toEqual({ ok: true, forwarded: true, attachmentsProcessed: 0 });
    expect(getPendingInvoiceForward(user.id)).toBeNull();
  });

  it("reports plainly when the body doesn't actually contain a findable expense", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("invoice-confirm-body-no-expense"));
    setPendingInvoiceForward(user.id, { accountId: 5, messageId: "m1", subject: "Newsletter" });
    mockHubGetMessage.mockResolvedValue({ attachments: [], body: "Just a regular update, no charges." });
    mockIngestEmailBodyReceipt.mockResolvedValue({ ok: false, reason: "no_expense_found" });

    const result = await runTool(user.id, "respond_to_invoice_forward_prompt", { confirm: true });

    expect(result).toEqual({ error: expect.stringContaining("couldn't find a clear amount/vendor") });
  });
});

describe("buildSystemPrompt pending invoice confirmation", () => {
  it("says nothing when there is no pending confirmation", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-invoice-none"));
    expect(buildSystemPrompt(user.id)).not.toContain("Pending Xero invoice confirmation");
  });

  it("surfaces the pending subject and instructs the model to call the tool on a yes/no reply", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-invoice-pending"));
    setPendingInvoiceForward(user.id, { accountId: 1, messageId: "m1", subject: "Invoice from Acme" });
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("Pending Xero invoice confirmation");
    expect(prompt).toContain("Invoice from Acme");
    expect(prompt).toContain("respond_to_invoice_forward_prompt");
  });
});

describe("buildSystemPrompt extract_email_attachment rule", () => {
  it("tells the model to use extract_email_attachment for a booking/receipt found as an email attachment", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-extract-attachment"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("extract_email_attachment");
  });
});

describe("ask_user_choice tool", () => {
  it("is always available with mode/options/confirm_tool/confirm_input in its schema", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-schema"));
    const tool = buildToolsForOwner(user.id).find((t) => t.name === "ask_user_choice");
    expect(tool).toBeDefined();
    const props = (tool!.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("question");
    expect(props).toHaveProperty("mode");
    expect(props).toHaveProperty("options");
    expect(props).toHaveProperty("confirm_tool");
    expect(props).toHaveProperty("confirm_input");
  });

  it("is excluded from runTool's generic dispatch — it must be intercepted before reaching here", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-runtool"));
    const result = await runTool(user.id, "ask_user_choice", {});
    expect(result).toEqual({ error: "unknown tool: ask_user_choice" });
  });
});

describe("buildSystemPrompt ask_user_choice rule", () => {
  it("instructs the model to confirm archiving via ask_user_choice instead of prose", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("ask-user-choice-rule"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("ask_user_choice");
  });
});

describe("make_app_link", () => {
  it("is offered to every user with no env or toggles", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-tool"));
    const names = buildToolsForOwner(user.id).map((t) => t.name);
    expect(names).toContain("make_app_link");
  });

  it("returns the built link", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-run"));
    const result = await runTool(user.id, "make_app_link", { app: "spotify", query: "lofi beats" });
    expect(result).toEqual({ url: "https://open.spotify.com/search/lofi%20beats", label: "Open in Spotify" });
  });

  it("returns validation errors to the model rather than throwing", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-err"));
    const result = (await runTool(user.id, "make_app_link", { app: "opentable" })) as { error?: string };
    expect(result.error).toMatch(/query/);
  });

  it("judges 'today' by the user's own timezone", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-tz"));
    setUserTimezone(user.id, "Pacific/Kiritimati"); // UTC+14: usually already 'tomorrow' vs the server
    const { DateTime } = await import("luxon");
    const localToday = DateTime.now().setZone("Pacific/Kiritimati").toFormat("yyyy-MM-dd");
    const result = (await runTool(user.id, "make_app_link", { app: "opentable", query: "X", date: localToday })) as { url?: string };
    expect(result.url).toContain(`dateTime=${localToday}T19%3A00`);
  });

  it("system prompt tells the model to use make_app_link and never claim a booking", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("applink-prompt"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("make_app_link");
    expect(prompt).toMatch(/never (say|claim).*(booked|ordered|playing)/i);
  });
});
