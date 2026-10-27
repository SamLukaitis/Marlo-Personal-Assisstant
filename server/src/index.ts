import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { SESSION_COOKIE_NAME } from "./middleware/auth.js";
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
import { joyceRoutes } from "./joyce/routes.js";
import { registerBridge } from "./bridge/index.js";
import { startJoyceReminderDelivery } from "./joyce/reminderDelivery.js";
import { isJoyceConfigured } from "./joyce/familyKey.js";
import { isJoyceWhatsAppConfigured } from "./joyce/whatsapp.js";
import { whatsappSettingsRoutes } from "./routes/whatsappSettingsRoutes.js";
import { documentRoutes } from "./routes/documentRoutes.js";
import { checkinRoutes, checkinReadRoutes } from "./routes/checkinRoutes.js";
import { phoneActionRoutes } from "./routes/phoneActionRoutes.js";
import { shortLinkRoutes } from "./routes/shortLinkRoutes.js";
import { searchRoutes } from "./routes/searchRoutes.js";
import { alertRoutes } from "./routes/alertRoutes.js";
import { toolsRoutes } from "./routes/toolsRoutes.js";
import { newsRoutes } from "./routes/newsRoutes.js";
import { adminRoutes } from "./routes/adminRoutes.js";
import { whatsappSimRoutes } from "./routes/whatsappSimRoutes.js";
import { portalRoutes } from "./routes/portalRoutes.js";
import { joycePortalRoutes } from "./routes/joycePortalRoutes.js";
import { helpChatRoutes } from "./routes/helpChatRoutes.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";
import { startScheduler } from "./services/scheduler.js";
import { startReminderScheduler } from "./services/reminderScheduler.js";
import { installLogCapture } from "./services/logCapture.js";
import { configureTrustProxy } from "./config.js";
import { isFlightsConfigured } from "./providers/flights.js";

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
configureTrustProxy(app);

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
// Joyce — the family assistant on her own WhatsApp number. Entirely separate storage from
// Marlo's: see src/joyce/familyDb.ts for why nothing here can reach the other's data.
app.use(joyceRoutes);
// The link between a person's Marlo and their family on Joyce: Joyce tells it when someone joins
// or leaves a family, and Marlo's assistant hands things over through it (src/bridge/).
registerBridge();

// Public: the one route a phone automation (iOS Shortcuts / Android Tasker) hits without any
// interactive login — gated by its own shared-secret header, resolved to an owner internally.
app.use(checkinRoutes);

// Public: the "Marlo" Shortcut calls these with a one-time code and no session.
app.use(phoneActionRoutes);

// Public: short links to booking/search pages, tapped from WhatsApp with no session.
app.use(shortLinkRoutes);

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
// Dev-only WhatsApp Simulator — lets Sam/Jake exercise the real inbound-message pipeline from a
// browser chat UI instead of a real phone. Only mounted when ENABLE_WHATSAPP_SIMULATOR is set
// (staging), never in production, and gated to admins even there — see whatsappSimRoutes.ts.
if (process.env.ENABLE_WHATSAPP_SIMULATOR === "true") {
  app.use("/api/dev", requireAdmin, whatsappSimRoutes);
}
// The Portal has ~15 endpoints that all share the same "must be admin" predicate, unlike
// adminRoutes.ts's routes (kept as inline isAdmin checks there) — a shared
// middleware makes more sense at this size. Mounted after the blanket requireAuth above, so
// req.userId is already set.
app.use("/api/portal", requireAdmin, portalRoutes);
// Joyce's admin portal — the same sections as the Portal, for the family assistant. Same gate.
app.use("/api/joyce-portal", requireAdmin, joycePortalRoutes);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Static privacy policy page, required by Meta's WhatsApp Business API setup (App Settings /
// App Review). Marlo is an invite-only personal assistant for a small, known set of users —
// this describes what it actually does rather than a boilerplate SaaS policy.
app.get("/privacy", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Marlo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  footer { margin-top: 3rem; color: #666; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Privacy Policy — Marlo</h1>
<p>Marlo is a private, invite-only personal assistant. It is not available to the public —
access is limited to a small number of individually invited users.</p>

<h2>What data Marlo accesses</h2>
<p>Depending on which integrations an invited user connects, Marlo may access: Gmail/Outlook
email, Google/Microsoft calendar events, Google Drive/OneDrive/Teams files, WhatsApp messages
sent to the assistant's number, documents a user uploads or sends, and location check-ins a
user opts to send.</p>

<h2>How it's used</h2>
<p>This data is used only to operate the assistant for the user who connected it — for example,
summarizing email, answering questions about a document, or replying to a WhatsApp message.
Message content is sent to Anthropic's Claude API to generate responses, and to Meta's WhatsApp
Cloud API to send and receive WhatsApp messages. Data is not sold, shared with advertisers, or
used for any purpose beyond operating the assistant for its invited users.</p>

<h2>Storage</h2>
<p>Data is stored on Marlo's own server infrastructure, accessible only to its operator.</p>

<h2>Deletion</h2>
<p>An invited user can request their data be deleted at any time by contacting the address
below.</p>

<h2>Contact</h2>
<p>${process.env.PRIVACY_CONTACT_EMAIL ?? "posidoniaenvironmental@gmail.com"}</p>

<footer>Last updated 2026-09-13.</footer>
</body>
</html>`);
});

// Static terms of service page, alongside /privacy above — also required for Meta's App Review
// submission (whatsapp_business_messaging permission).
app.get("/terms", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terms of Service — Marlo</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  footer { margin-top: 3rem; color: #666; font-size: 0.9rem; }
</style>
</head>
<body>
<h1>Terms of Service — Marlo</h1>
<p>Marlo is a private, invite-only personal assistant operated by Posidonia Environmental
Services Ltd. By using Marlo, an invited user agrees to these terms.</p>

<h2>Access</h2>
<p>Marlo is not available to the public. Access is by invitation only, at the operator's
discretion, and may be withdrawn at any time.</p>

<h2>Acceptable use</h2>
<p>Marlo is provided for personal, non-commercial use by its invited users. Users must not use
it for unlawful purposes, to send unsolicited messages to others, or to attempt to access
another user's data or account.</p>

<h2>Your data</h2>
<p>See the <a href="/privacy">Privacy Policy</a> for what data Marlo accesses and how it's
used.</p>

<h2>No warranty</h2>
<p>Marlo is provided "as is," without warranty of any kind. It is an assistant tool and may
make mistakes — users should verify anything important (e.g. dates, amounts, sent messages)
before relying on it.</p>

<h2>Limitation of liability</h2>
<p>To the extent permitted by law, Posidonia Environmental Services Ltd is not liable for any
indirect, incidental, or consequential loss arising from use of Marlo.</p>

<h2>Changes</h2>
<p>These terms may be updated from time to time. Continued use after a change means acceptance
of the updated terms.</p>

<h2>Governing law</h2>
<p>These terms are governed by the laws of England and Wales.</p>

<h2>Contact</h2>
<p>${process.env.PRIVACY_CONTACT_EMAIL ?? "posidoniaenvironmental@gmail.com"}</p>

<footer>Last updated 2026-09-13.</footer>
</body>
</html>`);
});

// Serve the built React client from the same process/port in production, so
// Railway (or any single-service host) only needs to run this one app — no
// separate static host, no cross-origin config. Falls back to index.html for
// any non-API route so client-side routing (react-router) still works.
const websiteDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../website/dist");
// The public Marlo website is the front door: signed-out visitors to "/" get it. Anyone with a session
// cookie, or arriving with a query string (the sign-in redirects use ?error= and ?not_invited=1, and
// "/?app=1" is the way to the old sign-in page), falls through to the React app below.
app.get("/", (req, res, next) => {
  const hasQuery = Object.keys(req.query).length > 0;
  if (req.cookies?.[SESSION_COOKIE_NAME] || hasQuery) return next();
  res.sendFile(path.join(websiteDist, "index.html"), (err) => {
    if (err) next();
  });
});
app.use(express.static(websiteDist, { index: false }));
const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/auth|\/health|\/webhooks).*/, (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  // A warning, so it shows in the Portal's Logs tab: without it the only sign that SerpApi isn't
  // being used is that replies quote Kiwi.com and lastminute.com prices.
  if (!isFlightsConfigured()) {
    console.warn(
      "travel search: SERPAPI_API_KEY isn't set, so flight search uses Kiwi.com and hotel search uses lastminute.com instead of Google Flights and Google Hotels"
    );
  }
});

// Only useful while the server keeps running — see README known limitations.
startScheduler();
// Joyce's reminders, sent when they come due. Only when she's set up — staging has no WhatsApp.
if (isJoyceConfigured() && isJoyceWhatsAppConfigured()) startJoyceReminderDelivery();
// Separate, much tighter interval than startScheduler's 5-minute tick — see
// reminderScheduler.ts for why reminders need their own accurate clock.
startReminderScheduler();

// Railway sends SIGTERM to the old instance the moment a new deploy's replacement is ready and
// serving, then SIGKILLs after a grace period. Node's default disposition for SIGTERM with no
// handler registered is immediate termination — and the `npm run start` wrapper this runs under
// reports that signal-kill as `npm error signal SIGTERM` with a non-zero exit code, which
// Railway's crash detector reads as "deployment crashed" on every single deploy, even though
// this is the normal, expected shutdown of the instance being replaced (the new one is already
// up by the time this fires). Handling the signal and exiting 0 ourselves stops that false alarm
// — confirmed via `railway logs <old-deployment-id>`: "Server listening..." then "Stopping
// Container" then "npm error signal SIGTERM", immediately followed by the new deployment's own
// clean "Server listening..." with nothing actually broken in between.
function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received — shutting down`);
  server.close(() => process.exit(0));
  // Safety net: force-exit if something (a lingering keep-alive connection, a stuck handler)
  // stops server.close()'s callback from ever firing — well inside Railway's SIGKILL grace
  // period, and unref'd so this timer itself never keeps the process alive if shutdown finishes
  // first.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
