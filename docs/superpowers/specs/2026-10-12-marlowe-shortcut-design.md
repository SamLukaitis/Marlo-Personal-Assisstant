# Marlowe Shortcut (phone actions) — design

_2026-10-12. Status: draft for review._

**Summary:** Each user installs one Apple Shortcut, "Marlowe", once. After that, Marlowe can send a
link that does things on their iPhone with a single tap: set alarms, timers and reminders, change
Focus and phone settings, text or call people from their own number, run their own Shortcuts, and
send information back to Marlowe (location, battery, sleep, steps, a typed answer). Marlowe offers
these in chat, in the morning briefing and evening recap, and on attention-gate reminders. Nothing
runs without the user's tap.

## Why

Sam asked whether Marlowe could trigger Apple Shortcuts on his behalf under preset rules. A server
can't start a Shortcut on someone's phone. iOS only runs one when the user taps a
`shortcuts://run-shortcut` link, or when an on-device automation fires. So we go with one tap per
request, and keep that tap as small as possible:

- **One install, not one Shortcut per feature.** The Marlowe Shortcut is a general runner. Marlowe
  sends it a list of steps, and it works through them. New abilities ship as a Shortcut update
  plus a server change, not a new install for each feature.
- **Marlowe picks the moment instead of hand-written rules.** The briefing and recap are already
  written by Claude, and they can see the calendar and bookings. So they suggest the action ("Early
  flight: tap for a 05:15 alarm + Sleep Focus at 22:30"). This covers the "preset rules" idea without
  a rules editor.
- **We're in testing with trusted users,** so the step list is deliberately broad. Problems are
  caught by reporting and version checks, not by keeping the feature small.

Marlowe can't build or install Shortcuts itself. iOS only imports signed Shortcuts, and signing
needs a Mac. That's why the Shortcut is built once by hand and shared as an iCloud link (see
`docs/marlowe-shortcut-build-guide.md`).

## How a run works

```text
Marlowe (chat / briefing / reminder)
  └─ createPhoneAction(owner, steps)  → stores steps under a random one-time code
  └─ sends   https://<SERVER_URL host>/a/<code>

User taps the link (WhatsApp only makes https:// links tappable)
  └─ GET /a/<code>        small public page: lists the steps in plain words,
                          "Run" button → shortcuts://run-shortcut?name=Marlowe&input=text&text=<fetch URL>
                          and an "Add the Marlowe Shortcut" link
  └─ the page redirects to that link automatically; the button is the fallback

Marlowe Shortcut on the phone
  1. checks the input URL starts with an allowed Marlowe host (else stops with an alert)
  2. GET  /api/phone-actions/<code>            header X-Marlowe-Shortcut: <version>
         → { steps: [...], reportUrl }          or { update: { installUrl, message } }
  3. for each step: run it, then POST /api/phone-actions/<code>/report
         { index, ok, value?, error? , version }
  4. final POST { done: true }
```

**Why a code and not the steps in the link:**
- Links stay short.
- Message text and contacts never sit in a URL.
- Codes expire and work once.
- A forged `shortcuts://` link can't get the phone to do anything, because the Shortcut only fetches
  steps from Marlowe's own hosts.

**Why a report after every step, not one at the end:** Shortcuts has no try/catch. A failing step
(e.g. a Focus called "Work" that doesn't exist on that phone) usually stops the whole run. Reporting
per step means Marlowe knows exactly which step failed. If a run was fetched but `done` never
arrives within 5 minutes, the step after the last one reported is marked failed.

## Steps (Shortcut version 1)

Steps are validated by a pure module, the same way `appLinks.ts` handles links. Each step type has
a fixed shape. Text fields are cleaned with the same `text()` rules as `appLinks.ts` (invisible
formatting stripped, code-point-safe length cap). At most 8 steps per action.

| Group | `type` | Fields | Shortcut action |
|---|---|---|---|
| Time | `alarm` | `time` HH:MM, `label?` | Create Alarm |
| | `timer` | `minutes` 1–1440 | Start Timer |
| | `reminder` | `title`, `due?` ISO local, `list?` | Add New Reminder |
| | `calendar_event` | `title`, `start`, `end`, `location?` | Add New Event (Apple Calendar) |
| Phone state | `focus` | `name` (e.g. "Work", "Sleep", "Do Not Disturb"), `on` bool, `until?` HH:MM | Set Focus |
| | `low_power` | `on` | Set Low Power Mode |
| | `volume` / `brightness` | `percent` 0–100 | Set Volume / Set Brightness |
| | `wifi` / `bluetooth` | `on` | Set Wi-Fi / Set Bluetooth |
| People | `text` | `to` (contact name or number), `body` ≤ 500 chars | Send Message, **Show When Run on** |
| | `call` / `facetime` | `to` | Call / FaceTime, **Show When Run on** |
| Apps & media | `open_url` | `url` (https only, or a `make_app_link` URL) | Open URLs |
| | `directions` | `destination`, `mode?` | Show Directions (Apple Maps) |
| | `note` | `title`, `body` | Create Note |
| | `clipboard` | `text` | Copy to Clipboard |
| Pass-through | `run_shortcut` | `name` | opens `shortcuts://run-shortcut?name=…` |
| Report back | `get_location` | — | Get Current Location → lat/lng |
| | `get_battery` | — | Get Battery Level |
| | `get_health` | `metric`: `sleep_last_night` \| `steps_today` | Find Health Samples |
| | `ask` | `prompt` | Ask for Input → the typed answer |

`text`, `call` and `facetime` always show iOS's own send/call screen. The Shortcut is built that
way, and the build guide tells users not to switch it off.

`run_shortcut` leaves the Marlowe Shortcut, so it must be the last step. The validator enforces
this, and Marlowe can't get a report from inside the other Shortcut.

**Versions:** `phoneSteps.ts` keeps `STEPS_BY_VERSION` (version 1 = everything above). Every fetch
sends the installed version. When an action contains a step that version doesn't support, the fetch
returns `update` instead. The Shortcut then shows the message and opens the install link, and
Marlowe records that phone's version so it won't offer those steps again until the next fetch shows
it updated. Before the first fetch, Marlowe assumes the current version.

## Server pieces

| File | Job |
|---|---|
| `server/src/services/phoneSteps.ts` | Pure: step types, `validateSteps(input, version)`, `describeSteps()` (plain-English summary for the page and messages), `STEPS_BY_VERSION`. Pinned by `phoneSteps.test.ts`. |
| `server/src/services/phoneActions.ts` | `createPhoneAction(ownerId, steps, {source, expiresAt})` → `{ url, summary }`; fetch, report and timeout handling; what happens after a report (below). |
| `server/src/routes/phoneActionRoutes.ts` | Public (mounted before the `/api` `requireAuth`, like `checkinRoutes`): `GET /a/:code`, `GET /api/phone-actions/:code`, `POST /api/phone-actions/:code/report`. The code is the only credential. |
| `server/src/db/store.ts` | Tables `phone_actions` (id, owner_id, code_hash, source, steps JSON, status, results JSON, created/fetched/done/expires) and `phone_shortcut_status` (owner_id, version, first_seen, last_seen, known_problems JSON). Both owner-scoped: add them to `deleteUserCompletely`. |
| `server/src/ai/assistant.ts` | New tool `make_phone_action`, always on when the feature is configured (like the Maps tools); handler; one system-prompt line about the user's Shortcut status. |
| `server/src/services/briefing.ts` | The briefing/recap prompt can include up to 3 suggestions as markers (below). |
| `server/src/services/attention*.ts` | Booking reminders carry suggested steps (below). |
| Portal | "Phone actions" tab: offered / tapped / done / failed per user, step type and error. |

**Codes:** 128 random bits, base64url. Only a SHA-256 hash is stored. A code can be fetched once.
A second fetch gets `410` with a plain message the Shortcut shows ("This link was already used").
Reports are accepted for 10 minutes after the fetch. Codes from chat expire after 24 hours. Codes
from the briefing, recap and reminders expire after 36 hours or when the event starts, whichever is
sooner.

**Config:** `MARLOWE_SHORTCUT_ICLOUD_URL` (the install link) and `MARLOWE_SHORTCUT_VERSION`. Until
the iCloud URL is set, the feature is dormant: no tool, no prompt text, no suggestions. Allowed
hosts in the Shortcut are the production and staging `SERVER_URL` hosts, written into the build
guide.

## What happens after a run

- **All "do" steps succeed:** no message, because the phone already shows the alarm, the Focus
  change and so on. The result is stored, so if asked, Marlowe can say "that ran at 22:31".
- **A step fails:** Marlowe sends one message naming the step and the error ("Couldn't turn on
  *Work* Focus. Is there a Focus with that name on your phone?"). It stores the problem in
  `known_problems` (step type + the field that failed), so the system prompt warns Marlowe not to
  repeat it. Problems older than 30 days drop off, so it can retry after the user fixes things.
- **Report-back steps (`get_location`, `get_battery`, `get_health`, `ask`):** the values go back
  into the conversation as a turn marked `[From your phone: …]`, and Marlowe replies on the channel
  the action came from. For WhatsApp, this goes through the normal `handleIncoming` reply path,
  which is fine because the user just tapped. For web, the values are attached to the next web
  chat turn. `get_location` is also saved with `saveCheckin(ownerId, …)`, so travel-day counting
  gets it.

These follow-ups are replies to something the user just did, not proactive messages. So they skip
the attention gate and don't count toward the daily limit of 4.

## Where Marlowe offers actions

**In chat (`make_phone_action`):** input `{ steps, label }`, output `{ url, summary }` or
`{ error }`. Tool description, in short:
- Use this for things on the user's iPhone that Marlowe can't do from the server.
- Offer it whenever it saves the user effort, not only when they ask.
- Combine related steps into one link.
- Never say it's done; say "tap to …".
- Put the URL on its own line.
- If the user hasn't run the Shortcut yet (no `phone_shortcut_status` row), the result also
  includes the install link, and Marlowe sends both: "First time: add the Marlowe Shortcut [link],
  then tap [link]".
- iPhone only: if the user says they're on Android, call `flag_unmet_request`.

**Morning briefing and evening recap:** only for users whose Shortcut has reported at least once.
The briefing prompt gets the step list and may add up to 3 suggestions. Each is written as
`[[phone|<label>|<steps JSON>]]`. After generation, `briefing.ts`:
1. validates each marker with `validateSteps`,
2. creates the action,
3. swaps the marker for `<label>: <url>`.

Invalid markers are dropped silently. The prompt asks for suggestions only when tomorrow's or
today's calendar gives a concrete reason: early starts, flights, long meetings, travel to an
address.

**Attention-gate reminders:** `AttentionDetails` gains optional `phoneSteps`. In `tripPrep.ts`:
- a flight with a known departure time gets an `alarm` 3 hours before;
- a hotel or restaurant with an address gets `directions`.

The link is created when the reminder is sent, not when it's queued, so the expiry is counted from
the moment the user sees it. The gate's tiers, daily limit and quiet hours don't change, because
the link rides on a message that was already going out.

## Error handling

| Case | Behaviour |
|---|---|
| Unknown, expired or used code | Page: "This link has expired, ask Marlowe again." Fetch: `410` + message. |
| Shortcut not installed | iOS shows "Shortcut not found". The `/a/` page always has an "Add the Marlowe Shortcut" link under the Run button. |
| Old Shortcut version | Fetch returns `update`, and the Shortcut shows the message and opens the install link. |
| Phone offline at tap | Fetch fails in the Shortcut, which shows "Couldn't reach Marlowe". The code is still unused and can be retried. |
| Report never arrives | After 5 minutes the run is marked failed at the step after the last reported one, and Marlowe sends one message. |
| Model sends invalid steps | Tool returns `{ error }` naming the field, like `make_app_link`. |

## Testing

- `phoneSteps.test.ts`: every step type, valid and invalid; length caps; `run_shortcut`-must-be-last;
  version gating; `describeSteps` wording.
- `phoneActions.test.ts`: code is single-use and stored hashed, expiry, per-step reports, the
  5-minute timeout, follow-up selection (silent / failure message / report-back turn),
  `known_problems` expiry, owner isolation.
- `phoneActionRoutes.test.ts`: public routes work without a session, `410` paths, the update
  response for an old version, the page escapes step text.
- Briefing marker parsing: valid, invalid JSON, unknown step, more than 3 markers.
- Attention: a flight reminder with a departure time carries an alarm link, and one without a time
  carries none.
- **Device check (manual):** `docs/marlowe-shortcut-device-check.md`. Tap every step type on a real
  iPhone through WhatsApp and through the web app, and confirm the per-step reports. Of particular
  note: whether WhatsApp's link opening adds a Safari "Open in Shortcuts?" prompt, whether Create
  Alarm and Set Focus accept text values, and the Health permission prompts.

## Build order

1. `phoneSteps.ts` + store tables + `phoneActions.ts` + routes + tests.
2. Build guide, then Sam builds the Shortcut on an iPhone and shares the iCloud link.
3. `make_phone_action` tool + install-link handling. Do the device check here.
4. Report-back follow-ups and `known_problems`.
5. Briefing/recap markers, then attention-gate reminders.
6. Portal tab, README, changelog.

## Not in this version

- **Android.** Tasker and MacroDroid can open a URL and make HTTP calls, so the same server API
  could serve an Android runner later.
- **Running with no tap.** That needs a native iOS app.
- A user-editable rules screen.
- The Chrome extension idea, which stays in the backlog.
