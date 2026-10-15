Marlowe can now do things on your iPhone with one tap: alarms, reminders, Focus, texts and calls, your own Shortcuts, and sending your location or sleep back to Marlowe.

## What changed

Each user adds one Apple Shortcut, "Marlowe", once. After that Marlowe sends links like "Tap to set a
05:15 alarm and turn on Sleep Focus". Tapping one opens a small page, which hands off to the Shortcut.
The Shortcut fetches the steps from Marlowe, runs them, and reports each step back.

Marlowe offers these in chat (`make_phone_action`), in the morning briefing and evening digest (up to
3, only when the calendar gives a reason), and on flight/hotel/restaurant reminders. Success is
silent. A failed step gets one message and is remembered. Location, battery, health and typed
answers go back into the conversation. The Portal has a Phone Actions tab.

## Why

Sam asked whether Marlowe could trigger Apple Shortcuts for him. A server can't start a Shortcut on
a phone; iOS needs a tap. One general Shortcut means one install, then one tap per action. New
abilities ship as Shortcut updates, not new installs.

## Notes

- Off until `MARLOWE_SHORTCUT_ICLOUD_URL` is set. Build the Shortcut from `docs/marlowe-shortcut-build-guide.md`.
- **Two Shortcut versions.** Version 1 (header `1`) has the nine core steps: alarm, timer, reminder, calendar_event, focus, low_power, text, call, open_url. Version 2 has all 22. Marlowe only offers steps the phone's version can run, so a version-1 phone is never sent directions or a location request.
- **Device check not done yet:** `docs/marlowe-shortcut-device-check.md`.
- iPhone only. Android (Tasker) could use the same API later.

Design: `docs/superpowers/specs/2026-10-12-marlowe-shortcut-design.md`.
