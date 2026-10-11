# App hand-off links — design

_2026-10-12. Status: draft for review._

**Summary:** Marlowe gets one new tool, `make_app_link`, that turns a plan ("a ride from here to
Dishoom", "a table for 4 at 8pm Friday") into a link that opens Uber, Lyft, OpenTable, Resy,
Spotify, Google Maps, Airbnb or Booking.com already filled in. The user taps it and confirms in
that app. There are no API keys, no OAuth and no new user setup, and the tool count grows by one.

## Why this and not MCP connections

The aim is to give users access to lots of lifestyle features without overloading the model with
tools (`assistant.ts` already sends about 59 tool definitions every turn).

What we found when we looked at the lifestyle apps users want (October 2026):

- **Spotify:** since May 2025, extended Web API access is limited to registered businesses with
  at least 250k MAU, and development mode is capped at 5 users. Composio or Pipedream doesn't get
  around this.
  ([1](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access),
  [2](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security))
- **Uber, OpenTable, Resy:** there's no open public API for booking on a user's behalf. Access
  is through partnerships only.
- **Pipedream** is being acquired by Workday, so its roadmap is uncertain. Composio is the
  better long-tail gateway when we get to one (see Later phases).

So connecting these apps by MCP or OAuth isn't available to us. Every one of them does support
**deep links / universal links** that pre-fill the screen, and that's what this design uses.
Having the user do the final tap is also the safer default for anything that costs money.

## User-facing behaviour

- "Get me an Uber to the airport": Marlowe replies with a short message and an Uber link where the
  pickup is the user's location (or the place they named) and the drop-off is filled in.
- "Book somewhere for 4 on Friday at 8": Marlowe finds places (`find_places`), the user picks one,
  and Marlowe sends an OpenTable or Resy link for that restaurant/search with party size, date and
  time pre-filled. Marlowe never says it has booked; it says "tap to confirm in OpenTable".
- "Play something chill": an `open.spotify.com/search/...` link.
- "Find me an Airbnb in Lisbon 3–6 Nov for 2": an Airbnb search link with those dates and guests.
- If the user asks Marlowe to actually complete the booking or payment, it explains that it opens
  the app ready to go and the user confirms there. It also calls `flag_unmet_request`, so we can
  see how often people want full booking, which is the signal for the browser-automation phase.

## Components

### `server/src/services/appLinks.ts` (new, pure, no I/O)

```ts
type AppLinkRequest =
  | { app: "uber" | "lyft"; pickup?: Place; dropoff: Place }
  | { app: "google_maps"; origin?: Place; destination: Place; mode?: "drive" | "walk" | "transit" | "bike" }
  | { app: "opentable"; query: string; partySize?: number; dateTime?: string /* local ISO */ }
  | { app: "resy"; city: string; query?: string; partySize?: number; date?: string }
  | { app: "spotify"; query: string }
  | { app: "airbnb"; location: string; checkIn?: string; checkOut?: string; adults?: number }
  | { app: "booking_com"; location: string; checkIn?: string; checkOut?: string; adults?: number };

type Place = { address?: string; name?: string; lat?: number; lng?: number }; // "current location" = omitted

export function buildAppLink(req: AppLinkRequest): { url: string; label: string } | { error: string };
```

- One small builder per app. Every value is URL-encoded, and the builder only ever produces its
  own fixed host (`m.uber.com`, `www.opentable.com`, …), so model input can never turn the link
  into a URL somewhere else.
- It validates instead of guessing. Party size must be 1–20, dates must be today or later and
  check-out must be after check-in. For a ride, an omitted `pickup` means "current location",
  which the apps handle themselves. Invalid input returns `{ error }`, and the model passes that
  on or asks the user.
- `label` is the button/link text, e.g. "Open in Uber".
- The URL formats live in this one file, so when an app changes its deep-link scheme the fix is a
  one-line change plus its test.

Starting URL formats. **Each one must be checked on a real iPhone and Android phone before it
ships**, and any app whose link doesn't pre-fill gets dropped from the enum:

| App | Format |
|---|---|
| Uber | `https://m.uber.com/ul/?action=setPickup&pickup=my_location` or `pickup[latitude]/[longitude]/[formatted_address]`, plus `dropoff[...]` |
| Lyft | `https://lyft.com/ride?id=lyft&pickup[latitude]=…&destination[latitude]=…` |
| Google Maps | `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&travelmode=…` |
| OpenTable | `https://www.opentable.com/s?term=…&covers=…&dateTime=…` |
| Resy | `https://resy.com/cities/<city-slug>?date=…&seats=…&query=…` (least certain, check first) |
| Spotify | `https://open.spotify.com/search/<query>` |
| Airbnb | `https://www.airbnb.com/s/<location>/homes?checkin=…&checkout=…&adults=…` |
| Booking.com | `https://www.booking.com/searchresults.html?ss=…&checkin=…&checkout=…&group_adults=…` |

### `make_app_link` tool (in `assistant.ts`)

- One pinned `Anthropic.Tool` definition, with a flat schema of `app` (enum) plus optional fields,
  and a description that says which fields each app uses. It's always offered (no env key), so the
  cached tools prefix stays constant.
- Not in `CONFIRM_REQUIRED_TOOLS`: making a link does nothing on its own; the user confirms
  inside the app.
- The handler maps the flat input to an `AppLinkRequest`, calls `buildAppLink` and returns
  `{ url, label }` or `{ error }`.
- System prompt rule: for rides, restaurant bookings, music, directions and stays, use
  `make_app_link` and never hand-write these URLs. Never claim something is booked, ordered or
  playing. Put the link on its own line. The existing Google Maps search-link rule for
  recommended places stays as it is.
- Coordinates come from the same sources `find_places` already uses (a recent location pin, or a
  `find_places` result), never invented.

### Delivery

The link goes in the normal reply text, and WhatsApp shows a link preview. A single
`sendWhatsAppCtaUrl` button would look nicer, but it needs a reply-shape change (a reply with an
attached link). We'll leave that for later, once the links have proven themselves.

## Error handling

- Validation errors come back to the model as `{ error }` text, and the model asks the user (for
  example "what date?").
- Nothing here calls a network, so there are no timeouts or retries.
- If the app isn't installed, the universal links open in the browser.

## Testing

- `appLinks.test.ts`: one exact-URL test per app, plus encoding of hostile input (`&`, `#`,
  `javascript:`, newlines), the host always staying fixed, the validation edges (party size 0/21,
  past dates, check-out before check-in), and the "current location" pickup.
- Assistant tool test: `make_app_link` is in the tools list without any env vars, and the handler
  passes through `{ url, label }` and `{ error }`.
- Manual: tap every format on iOS and Android with the app installed and without it.

## Out of scope / later phases

1. **Composio gateway** for productivity apps (Notion, Todoist, Slack, …): two meta-tools,
   `find_app_action` and `run_app_action`, so the tool count stays fixed however many apps are
   connected, with connect links only when a user first needs an app (per the lazy-reconnect
   rule). It gets its own spec when productivity apps become the priority.
2. **Browser automation** (Stagehand + Browserbase, idea #8 in `docs/integration-ideas.md`) for
   finishing bookings without a partnership. We'll only build it if `flag_unmet_request` shows
   real demand.
3. Using a CTA button to deliver links.
4. Anthropic tool search (`defer_loading`) to slim down the existing core tools.
