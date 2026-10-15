# Spike: building the Marlowe Shortcut with Cherri

**Date:** 2026-10-15. **Result:** promising. Cherri can describe the Marlowe Shortcut, but signing without a Mac
is unproven, and nothing has been run on a phone yet.

## Why

The "Marlowe" Apple Shortcut is built by hand on an iPhone from `docs/marlowe-shortcut-build-guide.md`, with a
long chain of `If` blocks. [Cherri](https://github.com/electrikmilk/cherri) is an open-source language that compiles
to Shortcut files. If it works, the Shortcut could live in this repo as code: reviewed, versioned, and rebuilt
instead of re-tapped whenever a step type is added.

## What was done

- Built Cherri v2.3.0 from source (Go, on Linux).
- Wrote the version 1 Shortcut (the nine core steps) in Cherri: `docs/spikes/cherri/Marlowe.cherri`.
- It compiles to an unsigned Shortcut with 161 actions: `cherri Marlowe.cherri --skip-sign`.
- Tried to sign it from Linux.

## Findings

### Signing

- On a Mac, Cherri calls Apple's own `shortcuts sign`. That is the reliable route.
- On Linux or Windows it sends the Shortcut to **HubSign**, a signing service run by RoutineHub
  (`https://hubsign.routinehub.services/sign`). It needs no account in Cherri's code. Cherri's README links it to a
  RoutineHub membership page, so it may be limited to members or free for now. **Not confirmed:** the cloud
  environment's network policy blocked the host, and routinehub.co could not be fetched.
- The only self-hosted option, [scaxyz/shortcut-signing-server](https://github.com/scaxyz/shortcut-signing-server),
  also runs `shortcuts sign`, so it needs a Mac too (or a macOS VM, which its own docs call a work in progress).
- **Conclusion:** without a Mac, signing depends on a third party (RoutineHub) whose terms aren't confirmed. It
  sees the Shortcut's contents, which include the Railway host names but no secrets.
- Cherri's [web playground](https://playground.cherrilang.org/) says it can export signed Shortcuts, which would
  be a quick way to test signing by hand.

### What Cherri can express

| Step | Status |
|---|---|
| Input check, link regex, fetch, message, update, loop, final `done` | Built-in actions, compiles |
| `alarm`, `timer`, `low_power`, `text`, `call`, `open_url` | Built-in actions, compiles |
| `focus` | Compiles, but Cherri needs the Focus chosen at build time. The spike branches on the five built-in Focus modes (Do Not Disturb, Sleep, Work, Personal, Driving). Turning a Focus **off** isn't in Cherri, so it uses a raw action. Custom Focus modes aren't supported. |
| `reminder`, `calendar_event` | Not in Cherri's library. The spike uses raw actions with **guessed** parameter names that have to be checked. |
| Version 2 steps (directions, note, health, ask, etc.) | Not tried. Health and Show Directions aren't in Cherri's library either, so they'd also be raw actions. |

### Gaps that affect the server contract

1. **The step report sends `index` as text, not a number.** Cherri only allows fixed values in a JSON request
   body, so a variable comes out as text. The server rejects it: `server/src/services/phoneActions.ts:158` requires
   `typeof index === "number"`. Fix: have the server also accept a whole-number string. This is a one-line change
   plus a test.
2. **Booleans from the server (`on`) are compared as text** (`"1"`). What Shortcuts actually turns `true` into
   needs checking on a phone.
3. Optional keys (`label?`, `due?`, `list?`, `location?`, `until?`) are passed through blank rather than
   skipped. This needs checking on a phone, especially the reminder due date.

## Recommended next steps

1. **Get the exact parameter names from the real Shortcut.** Run `cherri --import=<iCloud link>` on the
   hand-built Marlowe Shortcut's share link (the `MARLOWE_SHORTCUT_ICLOUD_URL` value). Cherri's import is in beta
   and decompiles the Shortcut. That gives the exact parameters for reminder, calendar event, health and directions
   instead of guessing.
2. **Test signing** on a Mac (`shortcuts sign`), or with the playground or HubSign, and confirm RoutineHub's terms
   before relying on it.
3. Make the server accept `index` as a whole-number string.
4. Run `docs/marlowe-shortcut-device-check.md` against the compiled Shortcut. Only after it passes should
   the Cherri file replace the hand-build guide as the source of truth.

If signing needs a Mac anyway, Cherri still helps: the Shortcut lives in git and is rebuilt with one command.
The Mac is then just a build machine, not a place to tap through 22 branches.
