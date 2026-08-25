# Let admins check which version is actually live

Came up directly from testing today (2026-08-26): after merging and pushing to `master`, there
was no way to tell from WhatsApp/the app itself whether Railway had actually finished deploying
the new code yet, or how long to wait before testing — only guessing based on typical deploy time,
or checking the Railway dashboard separately.

Idea: a hardcoded "version" command (e.g. typing `version` to Marlowe on WhatsApp, or a small
admin-only page/endpoint) that returns something definite to cross-reference against — e.g. the
git commit SHA that was actually built, and/or when that build happened. Doesn't need to be
AI-generated or clever — the opposite, actually: it should be a fixed, deterministic value baked
in at build/deploy time, not something the assistant guesses at or answers from memory.
