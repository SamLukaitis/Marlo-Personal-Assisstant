import { addServerLog } from "../db/store.js";

// Feeds the Portal's Logs tab (server/src/routes/portalRoutes.ts) without having to touch every
// individual console.error/console.warn call site across the codebase (there are dozens, e.g.
// scheduler.ts, assistant.ts, adminRoutes.ts). Wraps the two global console methods once at
// startup: the original method always runs first (so Railway's own log viewer / local terminal
// output is completely unaffected), then a best-effort copy is persisted to SQLite for the portal
// to display. Existing call sites already prefix messages like "scheduler: ..." / "assistant:
// ..." — that convention is preserved verbatim in what gets stored, so no separate "source"
// column is needed.
let installed = false;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function wrap(level: "error" | "warn"): void {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    // Logging must never itself crash the process or recurse back into console.error — any
    // failure here (e.g. the DB being briefly locked) is silently dropped, not re-logged.
    try {
      addServerLog(level, args.map(formatArg).join(" "));
    } catch {
      // swallow
    }
  };
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  wrap("error");
  wrap("warn");
}
