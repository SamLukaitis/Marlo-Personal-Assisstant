# Marlowe doesn't reliably know about its own automated messages

## Status

- [ ] Not started — flagged 2026-09-28 for Jake to think about, no code changed yet.

## Background (why this exists)

On 2026-09-28, Marlowe sent Jake the 9pm email digest over WhatsApp (visible in his chat).
About 25 minutes later, in the same conversation, Jake asked "are you aware of the 9pm summary
you sent me" and Marlowe replied that it had no way to confirm — "I don't have a tool that shows
me the delivery history of the daily email digest itself... I don't have a tool that logs or
shows the content/delivery history of automated things I send."

Investigated the same day: this was NOT a data-loss or delivery bug.
- Checked Railway's production logs for the exact send window — no errors, nothing suggesting
  the send or the history-write failed.
- The digest message was only ~5 conversational turns before Jake's question — well inside the
  24-message history window (`MAX_HISTORY_MESSAGES` in `server/src/ai/assistant.ts`), so the
  digest text was almost certainly sitting directly in Marlowe's own context when it answered.
- Marlowe already has a `search_conversation_history` tool built for exactly this kind of
  question, and its own recent messages don't even need it — they're already in context.

So the actual message text was very likely right there, and Marlowe still denied being able to
confirm it. This looks like a **behavior problem, not a plumbing problem**: the system prompt
repeatedly tells Marlowe to distrust its own memory of past replies and verify facts via tools
(e.g. "never state a specific value... from recollection alone" — see `server/src/ai/assistant.ts`
around line 1868/1890, written to stop it hallucinating email details). Marlowe appears to be
over-applying that caution even to its own literal prior turn in the same chat, instead of just
reading it back.

## The open question (why nothing's built yet)

Jake's pushback when this came up: fixing the system prompt doesn't *guarantee* the model will
behave consistently next time — prompt instructions are probabilistic by nature, not a code-level
guarantee. Before just tweaking the prompt and hoping, worth deciding how much confidence is
actually needed here and how to get it.

The repo already has a pattern for measuring this instead of eyeballing one transcript:
`server/src/eval/grounding.eval.ts` drives the real assistant against fixtures and supports
`EVAL_REPEAT=<n>` to catch flaky (inconsistent) behavior rather than averaging it away. A
reasonable path, if/when this gets picked up:

1. Add a scenario there: assistant sends a proactive message (digest/briefing/alert), then the
   user asks "are you aware of / what did you just send me" — grade whether the reply correctly
   references the sent content instead of deflecting.
2. Run it with several repeats to get an actual pass rate before touching the prompt.
3. Add the system-prompt instruction (Marlowe's own recent messages in this chat, including
   things it sent proactively, are ground truth it can read back directly — no tool needed for
   its *own* visible prior turns, as opposed to older stuff that's aged out of the window).
4. Re-run the eval with repeats to confirm the pass rate actually moved, not just that one manual
   test looked better.

Not committing to this plan yet — Jake wanted it captured to think about rather than acted on.
