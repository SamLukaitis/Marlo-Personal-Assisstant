import { defineConfig } from "vitest/config";

// Separate config for the grounding eval (src/eval/*.eval.ts) — deliberately not part of the
// default vitest.config.ts. It drives the real Anthropic API (real cost, real latency), so it
// must never run as a side effect of the normal `npm test` / CI unit-test pass. Run explicitly
// via `npm run eval:grounding`.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/eval/*.eval.ts"],
    testTimeout: 60_000,
    // Scenarios are network-bound (real Anthropic API calls), not CPU-bound, and independent of
    // each other (grounding.eval.ts's describe.concurrent + per-owner fixture data keying makes
    // this safe) — so running several at once cuts wall-clock time roughly proportionally
    // without changing how many API calls happen. Keep this moderate: too high risks tripping
    // Anthropic rate limits, which would show up as spurious scenario failures.
    maxConcurrency: 6,
  },
});
