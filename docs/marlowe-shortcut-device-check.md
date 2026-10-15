# Marlowe Shortcut: device check

Build the Shortcut from `docs/marlowe-shortcut-build-guide.md`, set `MARLOWE_SHORTCUT_ICLOUD_URL` and
`MARLOWE_SHORTCUT_VERSION=1` on staging, then do this on a real **iPhone** (iPhone only). For each
step type, ask Marlowe on WhatsApp for an action containing that step and tap the link there; then
repeat from the web app. Fill in the table. If a step misbehaves, fix the Shortcut, or the field
names in `server/src/services/phoneSteps.ts` plus its tests. Check the Portal "Phone actions" tab
shows each result.

Cell values: Y / N / n/a.

## Per step type

| Step type | Tapped from WhatsApp | Tapped from web | Ran | Report arrived | Notes |
|---|---|---|---|---|---|
| `alarm` | | | | | |
| `timer` | | | | | |
| `reminder` | | | | | |
| `calendar_event` | | | | | |
| `focus` | | | | | |
| `low_power` | | | | | |
| `volume` | | | | | |
| `brightness` | | | | | |
| `wifi` | | | | | |
| `bluetooth` | | | | | |
| `text` | | | | | |
| `call` | | | | | |
| `facetime` | | | | | |
| `open_url` | | | | | |
| `directions` | | | | | |
| `note` | | | | | |
| `clipboard` | | | | | |
| `run_shortcut` | | | | | |
| `get_location` | | | | | |
| `get_battery` | | | | | |
| `get_health` | | | | | |
| `ask` | | | | | |

## Extra checks

| Check | Result | Notes |
|---|---|---|
| WhatsApp → page → Shortcut: number of taps / Safari prompt? | | |
| Link preview didn't use up the code | | |
| Second tap says already used | | |
| Old version header gets update prompt | | |
| Airplane mode: Couldn't reach Marlowe, link still works after | | |
| Run killed mid-way → failure message within 10 min | | |

Things to watch in particular: whether WhatsApp adds a Safari "Open in Shortcuts?" prompt, whether
Create Alarm and Set Focus accept the text values, the Health and Location permission prompts, and
that `text`, `call` and `facetime` always show iOS's own send/call screen.

How to run the trickier checks:

- **Old version header:** in your copy of the Shortcut, temporarily set the header value to `0`, tap
  a fresh link, and confirm the "needs an update" alert and the install page open.
- **Killed mid-way:** start a multi-step action, force-quit Shortcuts after the first step, and wait.
  The run fails after 5 minutes of silence; Marlowe should message you within 10 minutes.
