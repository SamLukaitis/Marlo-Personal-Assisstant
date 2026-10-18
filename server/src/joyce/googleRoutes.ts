import { Router, type Response } from "express";
import crypto from "node:crypto";
import { isGoogleConnectTokenLive } from "./registry.js";
import { openFamilySessionForGoogleConnect } from "./familyDb.js";
import { saveMyGoogleAccount } from "./store.js";
import { shareFamilyCalendarWithMe } from "./familyCalendar.js";
import {
  MissingCalendarPermission,
  exchangeJoyceGoogleCode,
  isJoyceGoogleConfigured,
  joyceGoogleAuthUrl,
} from "./googleCalendar.js";

// The browser half of connecting a Google Calendar. Joyce has no website, so both pages are
// plain HTML served from here, and they end by sending the person back to WhatsApp.
//
//   1. /joyce/google/connect?t=…  — the link from WhatsApp. Checks the link is live, sets a
//      short-lived cookie, and sends the browser to Google.
//   2. /joyce/google/callback     — where Google sends them back. Requires the cookie from step 1,
//      so a Google sign-in started in someone else's browser can't be finished in this one, then
//      spends the link and saves the account into the family that link belongs to.
//
// The link is only spent at step 2. Cancelling on Google's screen leaves it working, so trying
// again from the same message just works.

export const joyceGoogleRoutes = Router();

const NONCE_COOKIE = "joyce_google_nonce";
const COOKIE_PATH = "/joyce/google";

function page(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>Joyce</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;` +
        `margin:4rem auto;padding:0 1rem;line-height:1.5;color:#222}h1{font-size:1.4rem}</style>` +
        `</head><body><h1>${title}</h1><p>${body}</p></body></html>`
    );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const ASK_AGAIN = "Go back to WhatsApp and ask Joyce to connect your Google Calendar again for a fresh link.";

interface ConnectState {
  t: string;
  n: string;
}

function parseState(raw: unknown): ConnectState | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return typeof parsed?.t === "string" && typeof parsed?.n === "string" ? parsed : null;
  } catch {
    return null;
  }
}

joyceGoogleRoutes.get("/joyce/google/connect", (req, res) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!isJoyceGoogleConfigured()) {
    page(res, 503, "Not available yet", "Google Calendar connections aren't switched on yet.");
    return;
  }
  if (!token || !isGoogleConnectTokenLive(token)) {
    page(res, 410, "This link has expired", `Links work once, for ten minutes. ${ASK_AGAIN}`);
    return;
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  res.cookie(NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 15 * 60 * 1000,
    path: COOKIE_PATH,
  });
  const state = Buffer.from(JSON.stringify({ t: token, n: nonce })).toString("base64url");
  res.redirect(joyceGoogleAuthUrl(state));
});

joyceGoogleRoutes.get("/joyce/google/callback", async (req, res) => {
  const state = parseState(req.query.state);
  const cookieNonce = req.cookies?.[NONCE_COOKIE] as string | undefined;
  const code = typeof req.query.code === "string" ? req.query.code : undefined;

  if (!state || !cookieNonce || state.n !== cookieNonce) {
    page(res, 400, "Something went wrong", `Please open the link from WhatsApp on this same device. ${ASK_AGAIN}`);
    return;
  }
  res.clearCookie(NONCE_COOKIE, { path: COOKIE_PATH });

  if (!code) {
    // Cancelled on Google's screen. The link wasn't spent, so it still works.
    page(res, 200, "Not connected", "Nothing was connected. You can tap the link in WhatsApp again if you change your mind.");
    return;
  }

  // Spent here, before talking to Google, so the same link can't be raced into two connections.
  const session = openFamilySessionForGoogleConnect(state.t);
  if (!session) {
    page(res, 410, "This link has expired", `Links work once, for ten minutes, and only while you're in the family. ${ASK_AGAIN}`);
    return;
  }

  try {
    const auth = await exchangeJoyceGoogleCode(code);
    saveMyGoogleAccount(session, auth);
    // A family calendar made before they connected is shared with them now. Failing here doesn't
    // undo the connection, which worked; the page just doesn't promise the calendar.
    const shared = await shareFamilyCalendarWithMe(session).catch((err) => {
      console.error("joyce: sharing the family calendar on connect failed", err);
      return "failed" as const;
    });
    const familyLine =
      shared === "shared"
        ? " Your family's shared calendar has been added to your Google Calendar too."
        : shared === "failed"
          ? " Your family's shared calendar couldn't be added to your Google Calendar just now; ask Joyce to add you to the family calendar."
          : "";
    page(
      res,
      200,
      "Google Calendar connected",
      `Joyce can now see <b>${escapeHtml(auth.email)}</b>'s calendar.${familyLine} You can close ` +
        `this page and go back to WhatsApp, where everyone in your family can ask her what's on ` +
        `or to add things.`
    );
  } catch (err) {
    if (err instanceof MissingCalendarPermission) {
      page(res, 400, "Calendar access wasn't allowed", `Joyce needs the calendar boxes ticked on Google's screen to work. ${ASK_AGAIN}`);
      return;
    }
    console.error("joyce: Google connect callback failed", err);
    page(res, 500, "Something went wrong", `Google didn't finish connecting. ${ASK_AGAIN}`);
  }
});
