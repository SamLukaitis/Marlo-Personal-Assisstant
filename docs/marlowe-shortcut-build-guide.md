# Building the "Marlo" Apple Shortcut

Marlo can't build or install a Shortcut for you: iOS only imports signed Shortcuts, and signing
needs a Mac. So one person builds it once, by hand, on an iPhone, and shares it as an iCloud link.
Follow this guide exactly. The server relies on every behaviour below. Design:
`docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md`.

## 1. What it is

One Shortcut named exactly **`Marlo`** (capital M, nothing else in the name). The run link Marlo
sends is `shortcuts://run-shortcut?name=Marlo&input=text&text=<fetch URL>`, so the name must match.
The Shortcut announces its version in the header `X-Marlo-Shortcut`. Marlo only offers the
steps that version can run (`STEPS_BY_VERSION` in `server/src/services/phoneSteps.ts`):

| Version | Steps it has | Header value |
|---|---|---|
| **1** (first build, for testing) | alarm, timer, reminder, calendar_event, focus, low_power, text, call, open_url | `1` |
| **2** (complete) | all 22 steps in the table below | `2` |

Build the version 1 branches first and test them. When every branch in the table is in, change
the header to `2` everywhere and follow section 6.

How it behaves, and what the server relies on:

- It receives one text input: `https://<host>/api/phone-actions/<code>`. The code is 22 characters
  of letters, digits, `-` and `_`.
- It fetches the steps, then runs them in order.
- It **reports after EVERY step**.
- Steps are **0-indexed** in reports: the first step is `index` 0 (that is `Repeat Index` - 1).
- For `run_shortcut` it reports ok **BEFORE** opening the other Shortcut (it can't report after).
- At the end it sends `{"done": true}`.
- The server finishes the run on its own once every step has reported ok, so a lost final `done`
  is harmless. A run that goes quiet for 5 minutes is failed at the first step that never reported,
  and the user gets one message.
- Each link works once. A second fetch gets HTTP 410 and a plain message.

## 2. Allowed hosts

The Shortcut must refuse any link that isn't from Marlo. The check is one regular expression
(step 2 below) listing the allowed hosts:

- Staging: `startupwjake-staging.up.railway.app`
- Production: **copy the host from `SERVER_URL` on Railway production and put it in the regex
  alongside staging.** It isn't recorded in this repo, so don't guess it. Host only: no `https://`,
  no trailing slash. Escape each `.` as `\.` in the regex.

## 3. Build steps

In the Shortcuts app: tap **+**, name it `Marlo`, then add these actions in order. In the
Shortcut's details (the `i` button), set it to accept **Text** input. Where a step says "dictionary",
use **Get Dictionary from Input** / **Get Dictionary Value** on the response.

1. **Input.** **If** *Shortcut Input* **has no value** → **Stop and Respond** with "Open a link from
   Marlo to use this."
2. **Check the link.** **Match Text** with pattern
   `^https://(PROD_HOST|startupwjake-staging\.up\.railway\.app)/api/phone-actions/[A-Za-z0-9_-]{22}$`
   on *Shortcut Input* (replace `PROD_HOST` with the escaped production host from section 2). **If**
   the match **has no value** → **Show Alert** "This link isn't from Marlo." → **Stop This
   Shortcut**. Then **Set Variable** `fetchUrl` to *Shortcut Input*.
3. **Fetch the steps.** **Get Contents of URL** `fetchUrl`, method **GET**, header
   `X-Marlo-Shortcut` = the version number (`1` or `2`). If the request fails because the phone is offline, show "Couldn't
   reach Marlo" and stop. (The link is still unused in that case, so the user can tap it again.)
4. **Message.** **Get Dictionary** from the response. **If** it **has key** `message` → **Show
   Alert** with the `message` value → **Stop This Shortcut**. (This is the HTTP 410 case: "already
   used" or "expired".)
5. **Update.** **If** it **has key** `update` → **Show Alert** with `update.message` → **Open URLs**
   with `update.installUrl` → **Stop This Shortcut**.
6. **Run the steps.**
   1. **Set Variable** `reportUrl` to the dictionary value `reportUrl`.
   2. **Get Dictionary Value** `steps`, then **Repeat with Each** item.
   3. Inside the loop: **Set Variable** `index` to **Calculate** `Repeat Index` - 1, and **Set
      Variable** `step` to *Repeat Item*. Get the value `type` from `step`.
   4. A chain of **If** `type` **is** `…` blocks, one per row of the table below. Each reads the
      listed keys from `step` and runs the listed action. Before the chain, **Set Variable** `value`
      to nothing, so it is empty for steps that return no value.
   5. After the chain (still inside the loop), report the step (section 4).
7. **Finish.** After the loop: **Get Contents of URL** `reportUrl`, method **POST**, header
   `X-Marlo-Shortcut` = the version number (`1` or `2`), request body **JSON** with one field: `done` (**Boolean**) = true.

### The 22 step types

Keys marked `?` are optional: only use them if the key exists.

| `type` | Keys it reads | Shortcut action |
|---|---|---|
| `alarm` | `time` ("HH:MM", 24-hour), `label?` | **Create Alarm** with that time and label |
| `timer` | `minutes` (number) | **Start Timer** for that many minutes |
| `reminder` | `title`, `due?` ("YYYY-MM-DDTHH:MM", local time), `list?` | **Add New Reminder** (set the due date if `due` exists, the list if `list` exists) |
| `calendar_event` | `title`, `start`, `end` ("YYYY-MM-DDTHH:MM", local time), `location?` | **Add New Event** (Apple Calendar) |
| `focus` | `name`, `on` (boolean), `until?` ("HH:MM") | **Set Focus**: turn the Focus called `name` on or off; if `until` exists, until that time |
| `low_power` | `on` | **Set Low Power Mode** |
| `volume` | `percent` (0-100) | **Set Volume** (percent / 100) |
| `brightness` | `percent` (0-100) | **Set Brightness** (percent / 100) |
| `wifi` | `on` | **Set Wi-Fi** |
| `bluetooth` | `on` | **Set Bluetooth** |
| `text` | `to` (contact name or number), `body` | **Send Message** to `to` with `body`; **Show When Run ON** |
| `call` | `to` | **Call** `to`; **Show When Run ON** |
| `facetime` | `to` | **FaceTime** `to`; **Show When Run ON** |
| `open_url` | `url` | **Open URLs** |
| `directions` | `destination`, `mode?` ("drive", "walk" or "transit") | **Show Directions** to `destination` (Apple Maps), using the mode if given |
| `note` | `title`, `body` | **Create Note** (title as first line, then body) |
| `clipboard` | `text` | **Copy to Clipboard** |
| `run_shortcut` | `name` | Report ok first (section 4), then **Open URLs** `shortcuts://run-shortcut?name=` + **URL Encode**(`name`). Always the last step. |
| `get_location` | none | **Get Current Location**, then a **Dictionary** with `latitude` and `longitude` as **Numbers** (not text); that dictionary is `value` |
| `get_battery` | none | **Get Battery Level**; the number (0-100) is `value` |
| `get_health` | `metric` ("sleep_last_night" or "steps_today") | **Find Health Samples**. For `sleep_last_night`: type Sleep Analysis, start date after yesterday 6 PM, then **Calculate Statistics** Sum of duration in hours. For `steps_today`: type Steps, start date today, **Calculate Statistics** Sum. The number is `value` |
| `ask` | `prompt` | **Ask for Input** (Text) with `prompt`; the typed text is `value` |

`text`, `call` and `facetime`: leave **Show When Run** on. That is what makes iOS show its own
send/call screen, so nothing is sent or dialled without the user pressing the button.

If an action fails, the Shortcut usually just stops, so the failed step never reports. That is
expected: the server fails the run after 5 minutes of silence and tells the user which step.

## 4. Reporting a step

After every step (inside the loop, after the chain of Ifs): **Get Contents of URL** `reportUrl`,
method **POST**, header `X-Marlo-Shortcut` = the version number (`1` or `2`), request body **JSON**:

| Field | Type | Value |
|---|---|---|
| `index` | Number | `index` (the 0-based number from step 6.3) |
| `ok` | Boolean | true |
| `value` | see below | only for the four report-back steps; leave the field out otherwise |

(The server also accepts `ok` false with an `error` text, but the Shortcut has no try/catch, so in
practice a failed step simply never reports. You don't need to build a failure report.)

Value shapes the server accepts (anything else is ignored):

- `get_location`: a dictionary `{"latitude": <number>, "longitude": <number>}`. Numbers, not text.
- `get_battery`: a number.
- `get_health`: a number (a string is also accepted).
- `ask`: the typed text.

`run_shortcut`: the report (`ok` true, no `value`) must come **before** the **Open URLs** action,
because opening the other Shortcut leaves this one. So for that step, report, then open. It is always
the last step, so the `done` POST in step 7 won't run; that's fine, because the server finishes the
run on its own once every step has reported ok.

## 5. Publishing

1. Test it with the device check: `docs/marlowe-shortcut-device-check.md`.
2. In the Shortcuts app: **Share → Copy iCloud Link**.
3. On Railway **staging**, set `MARLOWE_SHORTCUT_ICLOUD_URL` to that link and
   `MARLOWE_SHORTCUT_VERSION=1`. Redeploy and check it on staging.
4. Then set the same two variables on Railway **production**.

Until `MARLOWE_SHORTCUT_ICLOUD_URL` is set, phone actions stay off.

## 6. Updating (a new step type, or a fix)

1. If the step isn't already in `STEPS_BY_VERSION` (`server/src/services/phoneSteps.ts`), add it
   under a new key (never edit an old key). Going from version 1 to 2 needs no code change: key 2
   already lists all 22 steps.
2. Change the `X-Marlo-Shortcut` header value everywhere in the Shortcut to the new number.
3. Re-share with **Copy iCloud Link**. The link **changes** every time, so update
   `MARLOWE_SHORTCUT_ICLOUD_URL` and `MARLOWE_SHORTCUT_VERSION` on Railway (staging, then production).
4. People on the old version are asked to update when they tap a link that needs the new steps.

## 7. For users who add it

- After adding it, leave **Show When Run** on for Messages and Phone actions.
- On first use, allow the Health and Location prompts, and allow the Shortcut to run links.
- iPhone only.
