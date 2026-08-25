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
  },
});
