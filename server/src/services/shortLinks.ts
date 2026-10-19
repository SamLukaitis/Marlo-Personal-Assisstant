// Short links for the long booking and search URLs Marlowe sends (Google Flights and Google Hotels
// URLs run to several hundred characters, Kiwi.com and Booking.com not far behind), so a WhatsApp
// reply reads as text rather than as a wall of URL. <SERVER_URL>/go/<code> redirects to the stored
// URL (routes/shortLinkRoutes.ts). Only URLs Marlowe stored are reachable, so it isn't an open
// redirect.
import { randomBytes } from "node:crypto";
import { SERVER_URL } from "../config.js";
import { insertShortLink, getShortLinkUrl, deleteExpiredShortLinks } from "../db/store.js";

// Long enough that someone coming back to a trip a few weeks later still has a working link; the
// prices behind it will have moved by then, but the search itself still opens.
export const SHORT_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A URL this short is already readable (a hotel's own site, say), and shows where it goes.
const SHORTEN_ABOVE_CHARS = 60;

const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPrunedAt = 0;

export function shortLinkUrl(code: string): string {
  return `${SERVER_URL}/go/${code}`;
}

export function shortenUrl(ownerId: number, url: string, now = Date.now()): string {
  if (url.length <= SHORTEN_ABOVE_CHARS || !/^https?:\/\//i.test(url)) return url;
  if (now - lastPrunedAt > PRUNE_EVERY_MS) {
    lastPrunedAt = now;
    deleteExpiredShortLinks(now);
  }
  // 8 characters of base64url: 48 bits, plenty for a handful of links per user per day.
  const code = randomBytes(6).toString("base64url");
  insertShortLink({ code, ownerId, url, createdAt: now, expiresAt: now + SHORT_LINK_TTL_MS });
  return shortLinkUrl(code);
}

export function resolveShortLink(code: string, now = Date.now()): string | null {
  return getShortLinkUrl(code, now);
}

// The URL fields search_flights and search_hotels return, shortened in place before the model sees
// them — so the model can only ever repeat the short form.
const URL_KEYS = new Set(["googleFlightsUrl", "googleHotelsUrl", "bookingUrl", "website"]);

export function shortenResultLinks<T>(ownerId: number, value: T, now = Date.now()): T {
  if (Array.isArray(value)) return value.map((v) => shortenResultLinks(ownerId, v, now)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = URL_KEYS.has(key) && typeof v === "string" ? shortenUrl(ownerId, v, now) : shortenResultLinks(ownerId, v, now);
  }
  return out as T;
}
