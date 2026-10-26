# Marlo — keeping project docs up to date

When a piece of work is finished, update whichever of these apply, so the next person (or the next
Claude session) can pick up where things left off:

1. **README.md:** if what Marlo (or Joyce) can do has changed, or how it's set up or run has
   changed, update the README so it matches. A small internal fix doesn't need a README change.
2. **changelog/:** for any user-visible feature or meaningful fix, add a file named
   `YYYY-MM-DD-short-name.md`. Start with a one-line plain-English summary, then explain what
   changed and why, for someone reading it later with no context.
3. **feature-to-do/:** if the work finishes an idea in this folder, rename its file with the
   `done-` prefix and update the list in `feature-to-do/README.md`. If a new idea comes up for
   later, add a file for it.

Anything the next developer or Claude session needs to know belongs in this repo (README,
`changelog/`, `docs/` or this file), not only in Claude's private memory.
