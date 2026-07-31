import { Router } from "express";
import { saveCheckin, listCheckins, listAllCheckinsAscending } from "../db/store.js";
import { reverseGeocode } from "../services/geocode.js";
import { countTravelDays } from "../services/travelDays.js";

export const checkinRoutes = Router();

function isAuthorized(req: import("express").Request): boolean {
  const secret = process.env.CHECKIN_SECRET;
  if (!secret) return false; // fail closed if no secret is configured
  const provided = req.get("X-Checkin-Secret") ?? (req.query.secret as string | undefined);
  return provided === secret;
}

// Designed to be called directly by a phone automation (iOS Shortcuts, Android Tasker/
// MacroDroid) when it detects you've landed or crossed into a new region — not through
// WhatsApp, since WhatsApp requires a manual tap to send and can't be triggered silently.
checkinRoutes.post("/api/checkin", async (req, res) => {
  if (!isAuthorized(req)) {
    res.sendStatus(401);
    return;
  }

  const latitude = Number(req.body?.latitude ?? req.query.latitude);
  const longitude = Number(req.body?.longitude ?? req.query.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    res.status(400).json({ error: "latitude and longitude are required numbers" });
    return;
  }

  try {
    const { country, city } = await reverseGeocode(latitude, longitude);
    const checkin = saveCheckin({ latitude, longitude, country, city, checkedInAt: Date.now() });
    res.json(checkin);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

checkinRoutes.get("/api/checkins", (_req, res) => {
  res.json(listCheckins());
});

checkinRoutes.get("/api/travel-days", (req, res) => {
  const area = typeof req.query.area === "string" ? req.query.area : "schengen";
  const days = req.query.days ? Number(req.query.days) : 180;
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 24 * 60 * 60 * 1000;
  res.json(countTravelDays(listAllCheckinsAscending(), area, sinceMs, untilMs));
});
