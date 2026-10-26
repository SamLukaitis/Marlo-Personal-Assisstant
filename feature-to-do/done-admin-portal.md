# Admin portal for Jake, Sam, and other trusted people

Jake and Sam wanted a private area of the app — separate from the regular hub every user gets —
where they (and anyone else they choose to trust with it) can see what needs building, what's
breaking, and how the app is actually being used, without digging through Railway's dashboard or
the database by hand.

**✅ Done (2026-08-27).** A new **Portal** page, in the sidebar only for admins, with six tabs:

1. **Multiple admin logins.** Previously "admin" meant exactly one hardcoded account
   (`APP_OWNER_EMAIL`). Now any invited person can be made an admin from the Portal's Admins tab,
   and any existing admin can grant or remove it for anyone else already invited — not restricted
   to just the original owner. Each admin signs in with their own normal Google/Microsoft login
   and can use the Portal at the same time as everyone else, from their own computer. (The
   original owner-only invites/reset-test-phone section in Settings still works exactly as before
   — untouched, still gated to just the one owner account.)
2. **Unmet requests.** Marlo now quietly notes it down whenever it has to tell a user it can't
   do something (on web or WhatsApp) — a running list of real asks to work from, instead of
   relying on someone remembering to mention it.
3. **Logs, explained in plain English.** Every server error/warning is now captured automatically.
   Click "Explain this" on any of them and Claude reads the raw error and explains what likely
   went wrong and how serious it is, in normal language — cached after the first time so it's not
   re-explained (and re-billed) every time someone looks at it.
4. **Usage.** How many times the assistant was actually asked something, on web vs. WhatsApp,
   which model handled it, and a rough cost estimate — clearly labeled as approximate, not exact
   billing.
5. **Running to-do list**, shared across every admin.
6. **Poster board** — a place to leave notes for each other.

Refreshing the page is how you see what other admins added — deliberately kept simple rather than
building live push-updates, which would have meant standing up a new piece of infrastructure
(a socket server) this app doesn't otherwise have.

Built in: `server/src/routes/portalRoutes.ts` (the API), `server/src/services/logCapture.ts`
(captures every existing `console.error`/`console.warn` call automatically, without having to
touch each one), new tables in `server/src/db/store.ts` (`unmet_requests`, `server_logs`,
`api_usage`, `admin_todos`, `poster_notes`, plus an `is_admin` flag on `users`), a
`flag_unmet_request` tool in `server/src/ai/assistant.ts` (same pattern as the existing `remember`
tool), and `client/src/pages/PortalPage.tsx`.

**Known limitations, accepted rather than engineered around:**
- Unmet-request detection relies on the model noticing and reporting it itself — not a guaranteed
  audit, just a useful signal (same "the model's own judgment, not a hard guarantee" shape as
  Marlo's other proactive behaviors, e.g. the `remember` tool).
- The usage cost estimate uses a hardcoded approximate price table — worth updating by hand if
  Anthropic's pricing changes; it was never meant to match a real invoice exactly.
- No live-sync — everyone sees the same shared data, just not instantly; a manual refresh is
  needed to see someone else's latest change.
