import { defineConfig } from "vitest/config";

export default defineConfig({
  // Not "assets": the server also serves the React client, whose files live in /assets.
  build: { assetsDir: "site-assets" },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
});
