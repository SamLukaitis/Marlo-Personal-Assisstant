# Phone-first accounts

Makes a WhatsApp phone number sufficient to create a Marlowe account. Google/Microsoft OAuth
becomes an optional feature someone links when they want inbox and calendar help, rather than the
thing that brings the account into existence.

Spec: `docs/superpowers/specs/2026-09-17-phone-first-accounts-design.md`
Plan: `docs/superpowers/plans/2026-09-17-phone-first-accounts.md`

## Why

**Strategic.** The first thing Marlowe asked of a stranger was full mailbox access — Gmail
read/modify/compose, calendar, Drive, contacts — before they could send a single message. Testers
who would happily use reminders, notes and document storage had to hand over their inbox first.

**A live bug.** PR #65 added a Yes/No question before the email ask. Tapping **No** replied *"No
worries... Let me know how I can help!"* — but no account existed, so the state machine parked and
the person's next message was deflected back to the email question by an LLM helper whose job is
nudging them toward giving an email. Marlowe promised help and then refused to give any. Anyone
who tapped No was stuck until they relented.

## What changed

- `users.email` is nullable, via a transaction-wrapped table rebuild.
- A phone number alone creates an account (`findOrCreateUserByPhone`).
- Declining the email offer produces a **working** account — the next message reaches the
  assistant. This fixes the live bug.
- `connect_email` assistant tool lets someone link a mailbox later; the address attaches to their
  existing account rather than creating a second one.
- The assistant no longer tells WhatsApp-only users to visit a "Setup page" they cannot reach.
- API usage cost attribution keys on owner id rather than email address, so phone-first accounts
  do not all collapse into one unattributable bucket.

## Migration risk

The `users` rebuild runs at module load against the production SQLite file — the only change here
that can destroy data. Mitigations, all implemented:

- Wrapped in `db.transaction(...)`, so a crash mid-rebuild rolls back rather than leaving no
  `users` table.
- Row count verified before the `DROP`; a short copy throws and rolls back.
- `PRAGMA foreign_keys` disabled around the transaction and restored in `finally`. **This was
  wrong in the first implementation** — better-sqlite3 enables foreign keys by default, so
  `DROP TABLE users` is a parent-table drop against 29 FK-enforced children and threw. The
  transaction wrapper meant no data loss, but the server would have crash-looped. Caught in review.
- `sqlite_sequence` high-water mark preserved, so AUTOINCREMENT cannot reuse a deleted user's id.
- A single `VACUUM INTO` snapshot taken before the rebuild, under a fixed filename so a crash loop
  cannot fill the volume with copies.

**Not yet done: rehearse against a copy of production before deploying.** Pull the real `app.db`,
record `SELECT count(*) FROM users`, boot with `DATA_DIR` pointed at the copy, then confirm
`PRAGMA table_info(users)` shows `notnull=0` and the count is unchanged.

## Testing

1033 tests passing (was ~975 at the fork point), `tsc --noEmit` clean in both `server/` and
`client/`. Every task was implemented and reviewed separately, followed by a whole-branch review.

Notable coverage added: the migration's FK failure reproduced and its restoration asserted on both
the success and throwing paths; the row-count guard exercised through a Proxy seam that fails if
the guard is deleted; the `null`-owner WhatsApp routing fork, which had no coverage anywhere; a
negative control proving the unguarded post-connect chain really does overwrite briefing topics.

## Known follow-ups (not in this branch)

- `store.ts:571-587` drops `documents`, a parent table, in a bare `db.exec()` with foreign keys
  on — the same hazard fixed here for `users`. Latent because that migration has already run on
  most databases. Every rebuild in `store.ts` deserves a parent/child pass.
- The client has no `strictNullChecks`, so the null-email handling here has no compiler backing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01UyToYhgV5TEdu21cA3pefB
