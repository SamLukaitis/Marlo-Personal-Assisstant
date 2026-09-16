// The server's own public base URL — needed for links that go out over WhatsApp (plain text, not
// a same-origin SPA link), since those have to resolve to this Express server directly. Distinct
// from CLIENT_URL (server/src/routes/authRoutes.ts): in production they're the same origin (the
// server serves the built client itself), but in local dev the client runs on :5173 while this
// server is on :4000 — a WhatsApp message can't rely on relative paths, it needs the real host.
export const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:4000";

// In production (Railway) every request reaches Express through Railway's proxy, so req.ip is the
// proxy's address unless Express trusts X-Forwarded-For — and per-visitor limits like the help
// widget's then lump everyone into one bucket. Trusting a fixed hop count (not `true`) means
// req.ip is the entry the proxy itself appended, so a client can't choose its own IP by sending a
// fake X-Forwarded-For. TRUST_PROXY_HOPS overrides the default of 1 if the proxy chain changes.
export function configureTrustProxy(
  app: { set(setting: string, value: unknown): unknown },
  env: Record<string, string | undefined> = process.env
): void {
  const hops = env.TRUST_PROXY_HOPS !== undefined ? Number(env.TRUST_PROXY_HOPS) : env.NODE_ENV === "production" ? 1 : 0;
  if (Number.isInteger(hops) && hops > 0) app.set("trust proxy", hops);
}
