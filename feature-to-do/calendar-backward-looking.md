# Make the calendar assistant tool backward-looking, not just forward

Right now `list_upcoming_events` only ever queries from "now" forward (`days` ahead, default 7) —
there's no way to ask "what was on my calendar last week" or "when did I last meet with X." An
assistant should be able to answer what happened on a given date, not just what's coming up.
Possibly needs unique day/event IDs to make past events reliably referenceable (e.g. for follow-up
questions like "what was that meeting about"). See `server/src/ai/assistant.ts` (tool definition)
and `server/src/providers/google.ts` / `microsoft.ts` (the `timeMin`/`startDateTime` queries that
would need a past-looking counterpart).
