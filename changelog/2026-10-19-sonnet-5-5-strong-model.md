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

**Effort levels:** Sonnet 5.5 recalibrated what each effort level means, so they are now set
explicitly instead of left at the default (`high`): chat on the strong model runs at `medium`
(`ai/assistant.ts`), and the briefing and email digest at `low` (they turn a fixed list of facts
into prose, and at `low` the model mostly skips thinking, so it can't eat into their small
`max_tokens`). Document extraction keeps the default, since a misread code or number costs more
than the tokens. If replies get worse, raise these first.

**Not changed:** Joyce still defaults to `claude-sonnet-5` (`JOYCE_MODEL`).
