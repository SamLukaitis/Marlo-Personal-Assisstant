# Sonnet 5.5, and fast-first routing for everyone

Two follow-ups to the fast-first model routing (changelog 2026-10-19-fast-first-model-routing.md).

**1. Turn fast-first on for everyone.** It starts on admin accounts only. Once Jake and Sam have used
it for a few days, check the Portal's Usage tab: how many messages have an
`assistant_chat_escalated` row (the fast model handed over) and whether replies felt worse. If it
looks fine, set `ASSISTANT_FAST_FIRST=all` on Railway. If it escalates a lot, adjust the heavy-task
word list or the escalate tool's description in `server/src/ai/modelRouting.ts` / `assistant.ts`.

**2. Done (2026-10-19): the strong model is now Claude Sonnet 5.5** (changelog
2026-10-19-sonnet-5-5-strong-model.md). None of the strong-model calls disabled thinking or forced
`tool_choice` (the forced calls all run on the cheap Haiku 4.5 tier), so it was a swap of the
default model id. Still worth doing: compare replies, briefings and digests for a few days, and
try an explicit effort level (`medium` for chat, `low` for the briefing and digest) since Sonnet
5.5 recalibrated what each level means.
