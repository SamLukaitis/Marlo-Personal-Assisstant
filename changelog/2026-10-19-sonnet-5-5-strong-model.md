# Marlowe's stronger model is now Claude Sonnet 5.5

Drafting, planning, judgement calls, escalated chat messages, the morning briefing, the email
digest and document reading now run on Claude Sonnet 5.5 instead of Claude Sonnet 5. It costs the
same ($2 / $10 per million input / output tokens, cache reads $0.20) and is a newer, stronger
model.

**What changed:** the default for `ASSISTANT_MODEL_COMPLEX` (the strong tier) went from
`claude-sonnet-5` to `claude-sonnet-5-5` in `server/src/ai/modelRouting.ts`, `services/briefing.ts`,
`services/emailDigest.ts` and `services/documents.ts`. The Portal's Usage tab has a price for it, so
its rows show a cost instead of a blank. Setting `ASSISTANT_MODEL_COMPLEX=claude-sonnet-5` on
Railway switches back.

**Why it was a plain swap:** Sonnet 5.5 rejects two things Sonnet 5 accepted, turning thinking off
(`thinking: {type: "disabled"}`) and forcing a tool call (`tool_choice` `any` / `tool`). None of
the strong-model calls do either: chat uses adaptive thinking, and every forced tool call in the
code runs on the cheap Haiku 4.5 tier. Replies are read by block type, so the thinking blocks
Sonnet 5.5 returns don't get mistaken for the answer.

**Not changed:** Joyce still defaults to `claude-sonnet-5` (`JOYCE_MODEL`). No effort level is
set, so the strong model uses its default (`high`); Sonnet 5.5 recalibrated what each level means,
so comparing `medium`/`low` is a follow-up in `feature-to-do/sonnet-5-5-and-fast-first-for-all.md`.
