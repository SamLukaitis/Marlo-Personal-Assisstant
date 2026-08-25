// Deterministic, no AI in the loop (see feature-to-do/admin-version-check.md) — lets someone
// confirm exactly what's actually running in production, independent of whether the
// assistant/model layer itself is working. Railway auto-populates RAILWAY_GIT_* for services
// deployed from a connected GitHub repo; if it's missing, say so plainly rather than guess.
export function buildVersionText(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.RAILWAY_GIT_COMMIT_SHA;
  if (!sha) {
    return (
      "No commit info available in this environment (RAILWAY_GIT_COMMIT_SHA isn't set) — " +
      "this deploy may not be linked to a GitHub push."
    );
  }
  const message = env.RAILWAY_GIT_COMMIT_MESSAGE;
  return `Running commit ${sha.slice(0, 7)}${message ? ` — "${message.split("\n")[0]}"` : ""}.`;
}

const VERSION_TRIGGERS = new Set(["version", "what version", "which version"]);

export function isVersionTrigger(text: string): boolean {
  return VERSION_TRIGGERS.has(text.trim().toLowerCase());
}
