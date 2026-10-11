Marlowe can now send links that open Uber, Lyft, Google Maps, OpenTable, Resy, Spotify, Airbnb and Booking.com already filled in.

## What changed

A new `make_app_link` tool (`server/src/services/appLinks.ts`, wired up in `server/src/ai/assistant.ts`).
Ask Marlowe for a ride, a table, directions, music or a stay, and it replies with a link that opens that
app with the details pre-filled (drop-off, party size and time, dates and guests…). You confirm in the
app. Marlowe is told never to say it has booked, ordered or started anything itself.

## Why

These apps don't offer public APIs for acting on a user's behalf (Spotify limits its API to companies
with 250k+ monthly users; Uber, OpenTable and Resy are partner-only), so MCP/OAuth connections aren't
possible. Deep links need no keys and no user setup, and add only one tool to the tool list. When a user
asks Marlowe to complete a booking itself, Marlowe calls `flag_unmet_request`, so it shows up in the
Portal's Unmet Requests tab. That tells us whether to build browser automation next.

## Notes

- Lyft links need exact coordinates. For a place known only by name, Marlowe uses Uber or Google Maps.
- Text the URL parser would resolve away (".", "..") is refused rather than encoded.
- **Device check not done yet.** The URL formats are covered by tests, but nobody has tapped them on a
  phone yet. Use the checklist in `docs/app-handoff-links-device-check.md`, and drop any app whose
  link doesn't pre-fill (Resy is the least certain).

Design: `docs/superpowers/specs/2026-10-12-app-handoff-links-design.md`.
