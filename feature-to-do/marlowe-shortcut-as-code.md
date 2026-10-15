# Marlowe Shortcut as code (Cherri)

Right now the "Marlowe" Apple Shortcut is built by hand on an iPhone, following a long guide. Every new phone
action means tapping through the Shortcuts editor again, and there's no record of what changed.

The idea: write the Shortcut as code in this repo using Cherri, an open-source language that compiles to Apple
Shortcuts, and rebuild it with one command. A spike on 2026-10-15 got version 1 compiling. Open questions:
whether it can be signed without a Mac, and checking a few actions on a real phone.

Spike write-up and next steps: `docs/spikes/cherri-shortcut-spike.md`.
