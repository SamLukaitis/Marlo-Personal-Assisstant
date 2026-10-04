# Marlowe — working rules for Claude Code

Jake is a non-technical founder. Explain things in plain English, and give exact step-by-step
commands when he needs to run something himself.

## When a piece of work is finished

Before saying a change is done, do all of these that apply. Don't wait to be asked.

1. **Tests:** run `npm test` in `server/` and make sure everything passes. Say so plainly if anything fails.
2. **README.md:** if what Marlowe (or Joyce) can do has changed, or how it's set up or run has
   changed, update the README so it matches. A small internal fix doesn't need a README change.
3. **changelog/:** for any user-visible feature or meaningful fix, add a file named
   `YYYY-MM-DD-short-name.md`. Start with a one-line plain-English summary, then explain what
   changed and why, for someone reading it later with no context.
4. **feature-to-do/:** if the work finishes an idea in this folder, rename its file with the
   `done-` prefix and update the list in `feature-to-do/README.md`. If Jake mentions a new idea
   for later, add a file for it.
5. **Commit:** use short messages in the existing style (`feat: …`, `fix: …`, `docs: …`), written
   so a non-developer can tell what changed. Only commit when Jake asks.
6. **Tell Jake** which of the above you updated, in a line or two.

## Branches

- Work happens on `staging`. `master` is the main branch.
- Never push to `master` or deploy to Railway without Jake's go-ahead.

## Memory vs. project docs

- Anything the next developer (or the next Claude session) needs to know belongs in this repo:
  the README, `changelog/`, `docs/` or this file.
- Claude's private memory is only for things about how Jake likes to work, and for facts that
  aren't written down anywhere in the repo.
