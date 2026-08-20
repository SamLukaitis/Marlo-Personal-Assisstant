// The server's own public base URL — needed for links that go out over WhatsApp (plain text, not
// a same-origin SPA link), since those have to resolve to this Express server directly. Distinct
// from CLIENT_URL (server/src/routes/authRoutes.ts): in production they're the same origin (the
// server serves the built client itself), but in local dev the client runs on :5173 while this
// server is on :4000 — a WhatsApp message can't rely on relative paths, it needs the real host.
export const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4000";
