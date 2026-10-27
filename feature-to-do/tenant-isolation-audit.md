# Periodic check that no one can see another user's data

Came up while explaining data safety to Jake (2026-08-27): Marlo is multi-tenant — everyone's
data sits in one shared database, kept apart only by every query being scoped to `owner_id`. That
scoping is a discipline every new feature has to follow correctly, not something the system
enforces automatically by itself. As more features get added (and more people use the app), the
risk isn't "the AI decides to snoop" — it's a genuine mistake: a new database query, route, or
tool that forgets to filter by `owner_id` and accidentally leaks one person's data to another.

The idea: before each new feature ships (or on some regular cadence), do a sweep of the codebase
specifically looking for that one class of bug — any place that reads from the database without
scoping by the logged-in user (or, for WhatsApp, the phone-resolved user). Not a full security
review, just this one specific, repeatable check.

Not built yet — no tooling or checklist exists for this today. Options to figure out later:
a manual Claude Code pass over changed files before merging, a lightweight script that flags any
new store.ts query missing `owner_id`/`ownerId` in its WHERE clause, or folding it into the
existing `/code-review` habit as a standing check to always include.
