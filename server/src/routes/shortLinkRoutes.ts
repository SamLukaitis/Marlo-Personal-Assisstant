import { Router } from "express";
import { resolveShortLink } from "../services/shortLinks.js";

// Public, mounted before the blanket /api requireAuth (like phoneActionRoutes): the links are
// tapped from WhatsApp, with no session. The code is the only key, and it only leads to a URL
// Marlo stored for it (services/shortLinks.ts).
export const shortLinkRoutes = Router();

shortLinkRoutes.get("/go/:code", (req, res) => {
  const url = resolveShortLink(req.params.code);
  res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
  if (url) {
    res.redirect(302, url);
    return;
  }
  res
    .status(404)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Link expired</title><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5">` +
        `<h1 style="font-size:1.25rem">This link has expired</h1><p>Ask Marlo to search again for an up-to-date link.</p></body>`
    );
});
