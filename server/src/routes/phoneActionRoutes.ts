import { Router } from "express";
import { viewPhoneAction, fetchPhoneAction, reportPhoneStep } from "../services/phoneActions.js";
import { renderActionPage } from "../services/phoneActionPage.js";

// Public, mounted before the blanket /api requireAuth (like checkinRoutes): the "Marlowe" Shortcut
// has no session. The one-time code in the path is the only credential, and it only unlocks the
// steps Marlowe stored for it. See docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md.
export const phoneActionRoutes = Router();

phoneActionRoutes.get("/a/:code", (req, res) => {
  res
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .type("html")
    .send(renderActionPage(viewPhoneAction(req.params.code)));
});

phoneActionRoutes.get("/api/phone-actions/:code", (req, res) => {
  const header = Number(req.get("X-Marlowe-Shortcut"));
  const version = Number.isInteger(header) && header >= 0 ? header : 1;
  const outcome = fetchPhoneAction(req.params.code, version);
  res.set("Cache-Control", "no-store");
  if (outcome.kind === "gone") {
    res.status(410).json({ message: outcome.message });
  } else if (outcome.kind === "update") {
    res.json({ update: { installUrl: outcome.installUrl, message: outcome.message } });
  } else {
    res.json({ steps: outcome.steps, reportUrl: outcome.reportUrl });
  }
});

phoneActionRoutes.post("/api/phone-actions/:code/report", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const outcome = await reportPhoneStep(req.params.code, body);
  if (outcome === "ok") res.json({ ok: true });
  else if (outcome === "gone") res.status(410).json({ message: "This run is no longer open." });
  else res.status(400).json({ message: "Bad report." });
});
