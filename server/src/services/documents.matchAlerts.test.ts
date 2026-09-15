// Regression coverage for alert spam (reported 2026-09-15): every saved document that carried a
// booking code or flight number scanned the last 150 emails already in the inbox and sent one
// "an email about your <document> just came in" alert per matching email — the same identical-
// looking alerts again for every new document about the same booking. Saving a document now only
// indexes its match keys; genuinely new mail is matched by the scheduler scan
// (reconciliation.ts's checkNewEmailsAgainstRecentDocuments).
import { it, expect, vi } from "vitest";

const mockHubListMessages = vi.fn();
vi.mock("./hub.js", () => ({
  hubListMessages: (...args: unknown[]) => mockHubListMessages(...args),
  hubListNewMessages: vi.fn(),
  holdNewMessageCheckpoint: vi.fn(),
  hubGetAttachment: vi.fn(),
  hubGetMessage: vi.fn(),
}));

const mockSendWhatsAppMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../providers/whatsapp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/whatsapp.js")>()),
  sendWhatsAppMessage: (...args: unknown[]) => mockSendWhatsAppMessage(...args),
  sendWhatsAppTemplate: vi.fn().mockResolvedValue(undefined),
  isWhatsAppConfigured: () => true,
}));

vi.mock("./safeLinkFetcher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./safeLinkFetcher.js")>()),
  fetchPageText: vi.fn().mockResolvedValue({
    ok: true,
    text: "JetSMART boarding pass JA5443 Santa Marta to Medellin, booking V9MKMZ",
    finalUrl: "https://jetsmart.example/boarding",
    bytes: 100,
    truncated: false,
  }),
}));

// The extraction call: names the document and records its match keys, then writes the summary.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: vi.fn().mockResolvedValue({
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", id: "t1", name: "name_document", input: { title: "JetSMART Boarding Pass", category: "travel" } },
          { type: "tool_use", id: "t2", name: "record_match_keys", input: { referenceCode: "V9MKMZ", flightNumber: "JA5443" } },
          { type: "text", text: "A JetSMART boarding pass for flight JA5443." },
        ],
      }),
    };
  },
}));

const store = await import("../db/store.js");
const { ingestWhatsAppLink } = await import("./documents.js");

it("indexes a saved document's match keys without scanning existing mail or sending an alert", async () => {
  const user = store.findOrCreateUserByEmail(`doc-match-no-alert-${Date.now()}@example.com`);
  const phone = "447000077001";
  store.addPhoneNumberForUser(user.id, phone);
  store.recordInboundMessage(phone);
  mockHubListMessages.mockResolvedValue([
    {
      id: "old-1",
      accountId: 1,
      accountEmail: "me@example.com",
      provider: "google",
      subject: "Your JetSMART booking V9MKMZ is confirmed",
      from: "no-reply@jetsmart.com",
      snippet: "",
      receivedAt: new Date(Date.now() - 86_400_000).toISOString(),
      unread: false,
    },
  ]);

  const result = await ingestWhatsAppLink({ ownerId: user.id, phone, url: "https://jetsmart.example/boarding" });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let any fire-and-forget work settle

  expect(result.ok).toBe(true);
  expect(store.listRecentMatchKeys(user.id, Date.now() - 60_000)).toMatchObject([{ referenceCode: "V9MKMZ" }]);
  expect(mockHubListMessages).not.toHaveBeenCalled();
  expect(mockSendWhatsAppMessage).not.toHaveBeenCalled();
});
