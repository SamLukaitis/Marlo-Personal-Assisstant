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
vi.mock("../services/hub.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/hub.js")>();
  return { ...actual, hubGetMessage: (...args: unknown[]) => mockHubGetMessage(...args) };
});

import { buildToolsForOwner, buildSystemPrompt, runTool, messageForModel } from "./assistant.js";
import type { UnifiedMessage } from "../providers/types.js";
import {
  findOrCreateUserByEmail,
  setToolEnabled,
  getEnabledTools,
  listMemoryNotes,
  addMemoryNote,
  markMemorySurfaced,
} from "../db/store.js";
import { getBriefingSettings, saveBriefingSettings, type BriefingSettings } from "../services/briefing.js";
import { getXeroForwardingEmail } from "../services/xero.js";
import { setPendingInvoiceForward, getPendingInvoiceForward } from "../services/xeroInvoiceConfirmation.js";

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

  it("annotates a memory note that has an armed (not-yet-sent) trigger", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-memory-armed"));
    addMemoryNote(user.id, "Visa renewal is due", "2026-09-12T00:00:00Z");
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("Visa renewal is due");
    expect(prompt).toContain("reminder set for");
    expect(prompt).not.toContain("already sent");
  });

  it("annotates a memory note whose trigger already fired as already sent", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-memory-sent"));
    const past = new Date(Date.now() - 60_000).toISOString();
    const note = addMemoryNote(user.id, "Overdue reminder", past);
    markMemorySurfaced(user.id, note.id);
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("Overdue reminder");
    expect(prompt).toContain("reminder set for");
    expect(prompt).toContain("already sent");
  });

  it("renders an ordinary note with no triggerAt as a plain line with no annotation", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-memory-plain"));
    addMemoryNote(user.id, "The Acme account is my priority business");
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("- The Acme account is my priority business");
    expect(prompt).not.toContain("reminder set for");
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

describe("remember tool — triggerAt", () => {
  it("stores a parsed triggerAt when the model provides one", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-trigger"));
    const result = await runTool(user.id, "remember", {
      note: "Visa renewal is due",
      triggerAt: "2026-09-12T00:00:00Z",
    });
    expect(result).toEqual({ ok: true });

    const [saved] = listMemoryNotes(user.id);
    expect(saved.content).toBe("Visa renewal is due");
    expect(saved.triggerAt).toBe(new Date("2026-09-12T00:00:00Z").getTime());
  });

  it("stores no trigger when the model omits triggerAt, same as before", async () => {
    const user = findOrCreateUserByEmail(uniqueEmail("remember-notrigger"));
    const result = await runTool(user.id, "remember", { note: "Ordinary preference" });
    expect(result).toEqual({ ok: true });

    const [saved] = listMemoryNotes(user.id);
    expect(saved.triggerAt).toBeNull();
  });
});

describe("buildSystemPrompt onboarding paragraph", () => {
  it("is present when the user has never saved briefing settings", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-on"));
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).toContain("set_briefing_preferences");
  });

  it("is absent once briefing settings have been saved", () => {
    const user = findOrCreateUserByEmail(uniqueEmail("prompt-onboarding-off"));
    saveBriefingSettings(user.id, {
      enabled: true,
      includeNews: false,
      topics: [],
      includeMarkets: false,
      tickers: [],
      includeWeather: false,
      weatherLocation: "",
      proactive: false,
      sendTime: "07:30",
    });
    const prompt = buildSystemPrompt(user.id);
    expect(prompt).not.toContain("set_briefing_preferences");
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
