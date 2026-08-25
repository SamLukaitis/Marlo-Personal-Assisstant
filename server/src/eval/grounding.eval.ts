// Hallucination/grounding eval — drives the real assistant (real Anthropic API calls, real
// model) against fake fixtures (fake email/calendar data, no real accounts touched) and grades
// its replies deterministically. Run with `npm run eval:grounding` from server/ — NOT part of
// `npm test`, deliberately kept out of the default vitest config (see vitest.eval.config.ts)
// because every run costs real API calls and takes much longer than the unit suite.
//
// See docs/superpowers/specs (hallucination/grounding eval design) for the full rationale, and
// fixtures.ts for why these four query variants specifically.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";
import type { ChatMessage } from "../ai/assistant.js";
import type { ScenarioReport } from "./report.js";
import type { Fixture, VariantName } from "./fixtures.js";

vi.mock("../services/hub.js", () => ({
  hubListMessages: vi.fn().mockResolvedValue([]),
  hubGetMessage: vi.fn(),
  hubListEvents: vi.fn().mockResolvedValue([]),
  hubSearchFiles: vi.fn().mockResolvedValue([]),
  hubCreateDraft: vi.fn(),
  hubListChats: vi.fn().mockResolvedValue([]),
  hubSearchChats: vi.fn().mockResolvedValue([]),
  hubCreateEvent: vi.fn(),
  hubUpdateEvent: vi.fn(),
  hubDeleteEvent: vi.fn(),
  hubArchiveMessages: vi.fn().mockResolvedValue(0),
  hubAddLabel: vi.fn(),
  hubSearchContacts: vi.fn().mockResolvedValue([]),
  hubFlaggedMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/store.js")>();
  return {
    ...actual,
    // The eval never connects a real Google/Microsoft account — this stands in for one so
    // buildSystemPrompt/buildToolsForOwner see "an account is connected" and the model
    // actually reaches for list_recent_messages/list_upcoming_events instead of telling the
    // user to connect one first. hub.js above is fully mocked, so nothing this fake row points
    // at (tokens, provider) is ever used to make a real API call.
    listAccounts: vi.fn((ownerId: number) => [
      {
        id: 1,
        ownerId,
        provider: "google" as const,
        email: "eval@example.com",
        accessToken: "eval-fake-token",
        refreshToken: "eval-fake-token",
        expiryDate: null,
        authBroken: false,
        authBrokenAt: null,
      },
    ]),
  };
});

const { hubListMessages, hubListEvents } = await import("../services/hub.js");
const { findOrCreateUserByEmail } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { gradeReply } = await import("./grading.js");
const { buildHtmlReport } = await import("./report.js");
const { FIXTURES, VARIANT_NAMES } = await import("./fixtures.js");

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY is not set — the grounding eval drives the real model, add it to server/.env first."
  );
}

async function runScenario(fixture: Fixture, variantName: VariantName, ownerId: number): Promise<ScenarioReport> {
  vi.mocked(hubListMessages).mockResolvedValue(fixture.messages);
  vi.mocked(hubListEvents).mockResolvedValue(fixture.events);

  const turns = fixture.variants[variantName];
  let history: ChatMessage[] = [];
  let lastReply = "";
  for (const turnText of turns) {
    history.push({ role: "user", content: turnText });
    lastReply = await runAssistantChat(ownerId, history);
    history.push({ role: "assistant", content: lastReply });
  }

  const grade = gradeReply(fixture.groundTruth, lastReply);
  return {
    fixtureId: fixture.id,
    variant: variantName,
    prompt: turns[turns.length - 1],
    reply: lastReply,
    ...grade,
  };
}

const results: ScenarioReport[] = [];
let userCounter = 0;

describe("grounding eval", () => {
  for (const fixture of FIXTURES) {
    for (const variantName of VARIANT_NAMES) {
      // 60s: a real multi-turn agentic call (extended thinking + tool round-trips) comfortably
      // exceeds vitest's 5s default, especially under the pushback/multi-turn variants which
      // make 2-3 sequential calls each.
      it(
        `${fixture.id} / ${variantName}`,
        async () => {
          userCounter += 1;
          const user = findOrCreateUserByEmail(`eval-${fixture.id}-${variantName}-${userCounter}@example.com`);
          const result = await runScenario(fixture, variantName, user.id);
          results.push(result);
          expect(result.pass, result.reasons.join("; ") || "failed").toBe(true);
        },
        60_000
      );
    }
  }

  afterAll(() => {
    const outDir = path.resolve(import.meta.dirname, "../../eval-results");
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, "grounding-report.json");
    const htmlPath = path.join(outDir, "grounding-report.html");
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    fs.writeFileSync(htmlPath, buildHtmlReport(results));
    const passed = results.filter((r) => r.pass).length;
    // eslint-disable-next-line no-console
    console.log(`\nGrounding eval: ${passed}/${results.length} passed.\nReport: ${htmlPath}`);
  });
});
