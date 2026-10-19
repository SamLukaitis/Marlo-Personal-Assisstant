Most chat messages are now answered by Claude Haiku 5.5 (about 20× cheaper than Sonnet), stepping up to Sonnet only when it's needed. On for admin accounts first.

**Why.** A simple "what live music is on in Leeds on Saturday" went to Sonnet because it didn't
match the old "simple" keyword list, and cost about $0.18. Most messages are lookups like this.

**How a message is routed** (`server/src/ai/modelRouting.ts`):
- Obvious heavy tasks (draft, write, plan, compare, should I, recommend…) go straight to Sonnet.
- Everything else goes to Haiku 5.5 at low effort. Haiku has an `escalate_to_stronger_model` tool
  it calls when a request needs careful reasoning or judgement; Sonnet then answers from the same
  point (anything Haiku already did in that reply is kept, so nothing runs twice).
- If Haiku refuses, Sonnet answers instead.
- If the user pushes back on a Haiku reply ("that's wrong", "not what I asked", "try again", a
  bare "no"…), that message goes to Sonnet.
- After any of the last three, the conversation stays on Sonnet for the next 4 messages or 30
  minutes, so it doesn't drop back to the model the user just complained about.
- `ASSISTANT_FAST_FIRST` = `off` / `admins` (default) / `all`. With it off, the old keyword routing
  applies. Joyce isn't affected.

**Also in this change:**
- On Sonnet, web search uses `web_search_20260209`, which filters results before they reach the
  model, so far fewer tokens per search. Haiku keeps the basic version (the only one it supports).
- The Portal's prices were out of date: Sonnet 5 is $2/$10 per million tokens (was shown as
  $3/$15), and Haiku 5.5 ($0.10/$0.50) is added. Past costs in the Portal now show lower.
- An escalated reply is recorded as two usage rows: Haiku's abandoned attempt
  (`assistant_chat_escalated`) and Sonnet's answer. Railway logs show an `[assistant-route]` line
  per message with the model and reason.
