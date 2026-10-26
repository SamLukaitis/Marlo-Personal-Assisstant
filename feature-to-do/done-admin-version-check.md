# Let admins check which version is actually live

Came up directly from testing today (2026-08-26): after merging and pushing to `master`, there
was no way to tell from WhatsApp/the app itself whether Railway had actually finished deploying
the new code yet, or how long to wait before testing — only guessing based on typical deploy time,
or checking the Railway dashboard separately. It also directly answered "is Xero not connecting
because we got the code wrong, or because the deploy hasn't landed" — this is exactly that check.

**✅ Done (2026-08-26).** Texting `version` (or "what version"/"which version") to Marlo on
WhatsApp now replies with the exact git commit SHA and commit message Railway actually built,
read from Railway's own `RAILWAY_GIT_COMMIT_SHA`/`RAILWAY_GIT_COMMIT_MESSAGE` env vars — set
automatically for a GitHub-connected deploy, nothing to configure. Built in
`server/src/services/version.ts`, wired into `server/src/routes/whatsappRoutes.ts` as a
hardcoded short-circuit — same pattern as the existing "help" command — that answers *before* the
AI assistant is even called. That's deliberate: it means the version check still tells the truth
even if the assistant/tool layer itself is what's broken, which is exactly the kind of situation
this exists to diagnose.

Not admin-gated — any user who messages Marlo can currently check this (a commit SHA/message
isn't sensitive, so this was left simple rather than adding per-user role-gating for a one-off
diagnostic). Revisit if that stops being true.

One limitation worth knowing: if Railway ever deploys this app **without** a GitHub-connected
build (e.g. via `railway up` from a local checkout), those env vars won't be set, and the command
will say so plainly rather than pretend — which itself would be a useful, diagnostic answer.
