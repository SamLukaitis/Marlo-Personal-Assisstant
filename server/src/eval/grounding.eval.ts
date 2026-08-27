// Hallucination/grounding eval — drives the real assistant (real Anthropic API calls, real
// model) against fake fixtures (fake email/calendar data, no real accounts touched) and grades
// its replies deterministically. Run with `npm run eval:grounding` from server/ — NOT part of
// `npm test`, deliberately kept out of the default vitest config (see vitest.eval.config.ts)
// because every run costs real API calls and takes much longer than the unit suite.
//
// Scenarios run concurrently (see maxConcurrency in vitest.eval.config.ts) — they're
// independent, network-bound API calls, so wall-clock time scales with concurrency, not
// scenario count. Concurrency does NOT reduce the number of API calls made or their cost, only
// how long you wait for them.
//
// Set EVAL_REPEAT=<n> (e.g. `EVAL_REPEAT=3 npm run eval:grounding`) to run every scenario n
// times instead of once. Real model calls aren't deterministic — a scenario can pass on one run
// and fail on the next with zero code changes (see the flaky-scenario discussion this came
// from). A scenario only counts as a rigid PASS if every repeat passes; if repeats disagree it's
// reported as FLAKY (not silently averaged into a pass, and not conflated with a scenario that
// fails every time) — see report.ts's `flaky` field and the per-repeat breakdown it renders.
//
// See docs/superpowers/specs (hallucination/grounding eval design) for the full rationale, and
// fixtures.ts for why these five query variants specifically.
import "dotenv/config";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterAll } from "vitest";
import type { ChatMessage } from "../ai/assistant.js";
import type { RepeatRun, RunHistoryEntry, ScenarioReport } from "./report.js";
import type { Fixture, VariantName } from "./fixtures.js";

const REPEAT = Math.max(1, Number(process.env.EVAL_REPEAT) || 1);

// Scenarios run concurrently (see describe.concurrent below and maxConcurrency in
// vitest.eval.config.ts) so wall-clock time doesn't grow linearly with scenario count — these
// are independent, network-bound API calls, not CPU work, so there's no reason to serialize
// them. That means hubListMessages/hubListEvents can't just be "whatever mockResolvedValue was
// last set to" (a global, shared value) — two scenarios running interleaved would stomp on each
// other's fixture data mid-flight. Keying by ownerId instead works because every
// scenario/repeat gets its own unique owner (see nextOwnerId below), so concurrent reads/writes
// never touch the same map entry.
const fixtureDataByOwner = new Map<number, { messages: unknown[]; events: unknown[] }>();

vi.mock("../services/hub.js", () => ({
  hubListMessages: vi.fn(async (ownerId: number) => fixtureDataByOwner.get(ownerId)?.messages ?? []),
  hubGetMessage: vi.fn(),
  hubGetAttachment: vi.fn(),
  hubListEvents: vi.fn(async (ownerId: number) => fixtureDataByOwner.get(ownerId)?.events ?? []),
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

const { findOrCreateUserByEmail, saveDocument, saveEntity } = await import("../db/store.js");
const { runAssistantChat } = await import("../ai/assistant.js");
const { gradeReply } = await import("./grading.js");
const { buildHtmlReport } = await import("./report.js");
const { FIXTURES, VARIANT_NAMES } = await import("./fixtures.js");

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    "ANTHROPIC_API_KEY is not set — the grounding eval drives the real model, add it to server/.env first."
  );
}

interface SingleRun {
  prompt: string;
  reply: string;
  turns: ChatMessage[];
  durationMs: number;
  grade: ReturnType<typeof gradeReply>;
}

async function runScenarioOnce(fixture: Fixture, variantName: VariantName, ownerId: number): Promise<SingleRun> {
  fixtureDataByOwner.set(ownerId, { messages: fixture.messages, events: fixture.events });

  // documents/entities go straight into the real (test) DB — unlike hub.js, db/store.js isn't
  // mocked beyond listAccounts, so search_documents/list_recent_documents and
  // list_bookings/list_expenses see these for real. Each repeat gets a fresh ownerId, so this
  // never leaks between repeats or scenarios.
  for (const doc of fixture.documents ?? []) {
    saveDocument(ownerId, { phone: "eval-phone", storedPath: "/eval/fake-path", ...doc });
  }
  for (const entity of fixture.entities ?? []) {
    saveEntity(ownerId, entity);
  }

  const startedAt = Date.now();
  const userTurns = fixture.variants[variantName];
  let history: ChatMessage[] = [];
  let lastReply = "";
  for (const turnText of userTurns) {
    history.push({ role: "user", content: turnText });
    lastReply = (await runAssistantChat(ownerId, history)).text;
    history.push({ role: "assistant", content: lastReply });
  }

  return {
    prompt: userTurns[userTurns.length - 1],
    reply: lastReply,
    turns: history,
    durationMs: Date.now() - startedAt,
    grade: gradeReply(fixture.groundTruth, lastReply),
  };
}

async function runScenario(
  fixture: Fixture,
  variantName: VariantName,
  nextOwnerId: () => number
): Promise<ScenarioReport> {
  const runs: SingleRun[] = [];
  for (let i = 0; i < REPEAT; i++) {
    runs.push(await runScenarioOnce(fixture, variantName, nextOwnerId()));
  }

  const passCount = runs.filter((r) => r.grade.pass).length;
  const pass = passCount === runs.length;
  const flaky = REPEAT > 1 && passCount > 0 && passCount < runs.length;
  const last = runs[runs.length - 1];

  const repeats: RepeatRun[] = runs.map((r) => ({
    pass: r.grade.pass,
    reasons: r.grade.reasons,
    turns: r.turns,
    durationMs: r.durationMs,
  }));

  // Union of every distinct failure reason across the failing repeats — a flaky scenario's card
  // should show every way it went wrong, not just whichever repeat happened to run last.
  const reasons = [...new Set(runs.flatMap((r) => r.grade.reasons))];

  return {
    fixtureId: fixture.id,
    variant: variantName,
    prompt: last.prompt,
    reply: last.reply,
    turns: last.turns,
    durationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
    pass,
    flaky,
    missingFacts: last.grade.missingFacts,
    deniedFacts: last.grade.deniedFacts,
    inventedIdentifiers: last.grade.inventedIdentifiers,
    reasons,
    repeats,
  };
}

const results: ScenarioReport[] = [];
let userCounter = 0;
const runStartedAt = Date.now();

function openInBrowser(filePath: string): void {
  if (process.env.CI) return; // no display to open anything on in CI — the path is still printed
  const cmd =
    process.platform === "win32"
      ? `start "" "${filePath}"`
      : process.platform === "darwin"
        ? `open "${filePath}"`
        : `xdg-open "${filePath}"`;
  exec(cmd, (err) => {
    if (err) console.warn(`(could not auto-open the report — open it manually: ${filePath})`);
  });
}

describe.concurrent("grounding eval", () => {
  for (const fixture of FIXTURES) {
    for (const variantName of VARIANT_NAMES) {
      // 60s per repeat: a real multi-turn agentic call (extended thinking + tool round-trips)
      // comfortably exceeds vitest's 5s default, especially under the pushback/multi-turn
      // variants which make 2-3 sequential calls each; scaled by EVAL_REPEAT since a repeated
      // scenario runs that many times sequentially inside one `it`.
      it(
        `${fixture.id} / ${variantName}`,
        async () => {
          const nextOwnerId = (): number => {
            userCounter += 1;
            return findOrCreateUserByEmail(`eval-${fixture.id}-${variantName}-${userCounter}@example.com`).id;
          };
          const result = await runScenario(fixture, variantName, nextOwnerId);
          results.push(result);
          const failMessage = result.flaky
            ? `flaky across ${REPEAT} repeats: ${result.reasons.join("; ")}`
            : result.reasons.join("; ") || "failed";
          expect(result.pass, failMessage).toBe(true);
        },
        60_000 * REPEAT
      );
    }
  }

  afterAll(() => {
    const outDir = path.resolve(import.meta.dirname, "../../eval-results");
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, "grounding-report.json");
    const htmlPath = path.join(outDir, "grounding-report.html");
    const historyPath = path.join(outDir, "history.json");

    const passed = results.filter((r) => r.pass).length;
    const flakyCount = results.filter((r) => r.flaky).length;
    const timestamp = new Date().toISOString();

    // Trend across runs — so "run the tests and see what's happening" after adding a feature
    // means seeing whether the pass rate moved, not just this run's snapshot. Capped so the
    // file (and the report's history table) doesn't grow unbounded.
    let history: RunHistoryEntry[] = [];
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    } catch {
      // No history yet (first run) — start fresh.
    }
    history.push({ timestamp, passed, total: results.length });
    history = history.slice(-20);
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    fs.writeFileSync(
      htmlPath,
      buildHtmlReport(results, { timestamp, durationMs: Date.now() - runStartedAt, history })
    );

    const flakyNote = flakyCount > 0 ? ` (${flakyCount} flaky)` : "";
    // eslint-disable-next-line no-console
    console.log(`\nGrounding eval: ${passed}/${results.length} passed${flakyNote}.`);
    // eslint-disable-next-line no-console
    console.log(`Report: ${htmlPath}`);
    openInBrowser(htmlPath);
  });
});
