import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { authRoutes } from "./routes/authRoutes.js";
import { meRoutes } from "./routes/meRoutes.js";
import { accountRoutes } from "./routes/accountRoutes.js";
import { dataRoutes } from "./routes/dataRoutes.js";
import { settingsRoutes } from "./routes/settingsRoutes.js";
import { assistantRoutes } from "./routes/assistantRoutes.js";
import { localRoutes } from "./routes/localRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";
import { briefingRoutes } from "./routes/briefingRoutes.js";
import { memoryRoutes } from "./routes/memoryRoutes.js";
import { whatsappRoutes } from "./routes/whatsappRoutes.js";
import { whatsappSettingsRoutes } from "./routes/whatsappSettingsRoutes.js";
import { documentRoutes } from "./routes/documentRoutes.js";
import { checkinRoutes, checkinReadRoutes } from "./routes/checkinRoutes.js";
import { searchRoutes } from "./routes/searchRoutes.js";
import { alertRoutes } from "./routes/alertRoutes.js";
import { toolsRoutes } from "./routes/toolsRoutes.js";
import { newsRoutes } from "./routes/newsRoutes.js";
import { adminRoutes } from "./routes/adminRoutes.js";
import { portalRoutes } from "./routes/portalRoutes.js";
import { helpChatRoutes } from "./routes/helpChatRoutes.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";
import { startScheduler } from "./services/scheduler.js";
import { installLogCapture } from "./services/logCapture.js";

// Installed before anything else has a chance to log, so every console.error/console.warn from
// here on (including ones during route registration below) is captured for the admin Portal.
installLogCapture();

// Safety net: an uncaught async error anywhere (a route handler, the scheduler, a webhook
// handler) would otherwise crash the whole process — Node's default since v15 is to terminate
// on an unhandled promise rejection. Railway auto-restarts a crashed process within seconds, so
// it can look "Active" again by the time you check the dashboard, but you still lose in-flight
// work and get a crash notification. Logging and staying up is the right behavior for a server
// that should just keep running; individual routes should still have their own try/catch so
// callers get a proper error response instead of a hung request, but this is the backstop.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const app = express();
const PORT = process.env.PORT ?? 4000;

// credentials: true is required for the browser to actually send the session cookie — without
// it, a cross-origin request (local dev: client on :5173, server on :4000) silently drops
// cookies regardless of what the client sets on fetch().
app.use(cors({ origin: process.env.CLIENT_URL ?? "http://localhost:5173", credentials: true }));
app.use(
  express.json({
    // WhatsApp webhook signature verification needs the exact raw bytes, not the
    // re-serialized parsed body — capture them here for every request (cheap, harmless).
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  })
);
app.use(cookieParser());

// Public: the OAuth login/connect/callback routes gate themselves internally (login-signin is
// open, the "connect" pair requires a session via its own requireAuth on those specific routes —
// see authRoutes.ts).
app.use(authRoutes);

// Public: Meta calls these directly (webhook verify handshake + signed POST), not a logged-in
// browser — gated by its own verify-token/HMAC checks, not a session.
app.use(whatsappRoutes);

// Public: the one route a phone automation (iOS Shortcuts / Android Tasker) hits without any
// interactive login — gated by its own shared-secret header, resolved to an owner internally.
app.use(checkinRoutes);

// Public: the marketing homepage's help widget, for visitors who haven't signed in yet — must be
// registered before the blanket /api requireAuth below, or the site's own logged-out visitors
// would get 401s from it. Gated only by its own per-IP rate limit (helpChatRoutes.ts), not a
// session — it has no access to real user data by design.
app.use(helpChatRoutes);

// Everything else under /api/* requires a logged-in session.
app.use("/api", requireAuth);
app.use(meRoutes);
app.use(accountRoutes);
app.use(dataRoutes);
app.use(settingsRoutes);
app.use(assistantRoutes);
app.use(localRoutes);
app.use(chatRoutes);
app.use(briefingRoutes);
app.use(memoryRoutes);
app.use(whatsappSettingsRoutes);
app.use(documentRoutes);
app.use(checkinReadRoutes);
app.use(searchRoutes);
app.use(alertRoutes);
app.use(toolsRoutes);
app.use(newsRoutes);
app.use(adminRoutes);
// The Portal has ~15 endpoints that all share the same "must be admin" predicate, unlike
// adminRoutes.ts's 4 owner-only routes (kept as inline isAppOwner checks there) — a shared
// middleware makes more sense at this size. Mounted after the blanket requireAuth above, so
// req.userId is already set.
app.use("/api/portal", requireAdmin, portalRoutes);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Serve the built React client from the same process/port in production, so
// Railway (or any single-service host) only needs to run this one app — no
// separate static host, no cross-origin config. Falls back to index.html for
// any non-API route so client-side routing (react-router) still works.
const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/auth|\/health|\/webhooks).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// Only useful while the server keeps running — see README known limitations.
startScheduler();
