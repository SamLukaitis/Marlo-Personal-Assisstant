import { describe, it, expect } from "vitest";
import { buildVersionText, isVersionTrigger } from "./version.js";

describe("buildVersionText", () => {
  it("reports the short commit SHA and first line of the commit message when Railway has set them", () => {
    const text = buildVersionText({
      RAILWAY_GIT_COMMIT_SHA: "3561d8e10bbbc78365556dcab1e4dacf8df0e6ff",
      RAILWAY_GIT_COMMIT_MESSAGE: "Add feature-to-do: let admins check which version is live\n\nmore detail",
    } as NodeJS.ProcessEnv);
    expect(text).toBe('Running commit 3561d8e — "Add feature-to-do: let admins check which version is live".');
  });

  it("still reports the SHA when there is no commit message", () => {
    const text = buildVersionText({ RAILWAY_GIT_COMMIT_SHA: "abcdef1234567" } as NodeJS.ProcessEnv);
    expect(text).toBe("Running commit abcdef1.");
  });

  it("says plainly when there is no commit info at all, instead of guessing", () => {
    const text = buildVersionText({} as NodeJS.ProcessEnv);
    expect(text).toContain("No commit info available");
  });
});

describe("isVersionTrigger", () => {
  it("matches 'version' case-insensitively with surrounding whitespace", () => {
    expect(isVersionTrigger("version")).toBe(true);
    expect(isVersionTrigger("  Version ")).toBe(true);
    expect(isVersionTrigger("VERSION")).toBe(true);
  });

  it("matches the other exact phrasings", () => {
    expect(isVersionTrigger("what version")).toBe(true);
    expect(isVersionTrigger("which version")).toBe(true);
  });

  it("does not match a sentence that merely mentions version", () => {
    expect(isVersionTrigger("what version am I on right now?")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(isVersionTrigger("hello")).toBe(false);
  });
});
