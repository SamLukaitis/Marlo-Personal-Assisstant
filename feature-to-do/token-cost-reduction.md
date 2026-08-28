# Token cost reduction — trim tool results, cache conversation history, treat evals as spend

## Status

- [x] #1 Trim search/list result snippets — `trimSnippetForList` in `server/src/ai/assistant.ts`
- [x] #2 Cache breakpoint on conversation messages — `withMessagesCacheBreakpoint` in the same
      file, applied in `runAssistantChat`'s loop
- [ ] #3 Treat eval runs as deliberate spend — practice/optional guard, not yet enforced in code

## Background (why this exists)

Investigated 2026-08-28 after API spend jumped from under $1/day to tens of dollars/day starting
the morning of Aug 26. The cause was NOT a bug or the memory function — it was a combination of:

- The grounding eval (`npm run eval:grounding`) drives the **real** assistant with real API
  calls: ~70 scenario-runs, each up to 8 internal turns. One full run costs roughly $5–15.
  The Aug 26/27 usage spikes line up with dev sessions where the eval was being run.
- Aug 26 features made every real conversation heavier: search results raised to 30 per query,
  the model instructed to decompose broad searches into sub-queries (more internal turns), and
  attachment extraction (more turns again).
- Each internal turn of the assistant loop resends everything: the ~15–20k-token tools+system
  prefix (cached, cheap — this is the big "prompt caching read" number in the Anthropic
  console, and it's the discount working, not the problem) plus the growing pile of tool
  results from earlier turns of the same message (UNCACHED, full price — this is the real
  money).

The Usage tab now records cache read/write tokens (added same day), so the effect of each fix
below is directly measurable in the admin portal.

## What to build, in order of impact

### 1. Trim what search results feed the model (biggest win)

Today a single `search_messages` call feeds the model 30 full results (subject, from, snippet,
etc. — ~5–10k tokens), and a broad question triggers several such searches. All of it is
replayed at full input price on every later turn of the same message's loop — turn 7 can be
re-sending 40k+ tokens of search results for the fourth time.

- In `server/src/ai/assistant.ts`, `messageForModel()` is the single funnel where a message is
  shaped for the model — trim there: shorten snippets (e.g. cap at ~150 chars for list/search
  results), and drop fields the model doesn't need to decide which email to open fully
  (it can always call `get_message` for the full body).
- Keep `get_message` (single message) untrimmed — that's the "open it" path.
- Don't lower the 30-result limit itself without checking with Jake — the depth was raised
  deliberately on Aug 26 because 10 was missing older confirmation emails. Shorter rows, not
  fewer rows, is the intended fix.

### 2. Add a cache breakpoint on conversation messages

The tools+system prefix is already cached (1h TTL). The `messages` array is not, so within one
message's loop, every turn re-pays full price for all earlier turns' tool results — the exact
cost item in (1).

- In `runAssistantChat`'s loop, add `cache_control: { type: "ephemeral", ttl: "1h" }` to the
  final content block of the last message before each request (and remove it from the previous
  turn's block so there are never more than the allowed number of breakpoints — max 4 total
  per request, and 2 are already used by tools + system).
- Because each turn only APPENDS to `messages`, the prefix stays byte-identical, so turn N+1
  re-reads turn N's history at 10% price instead of 100%.
- Verify it works by watching `cache_read_input_tokens` climb (and `input_tokens` shrink) per
  turn — the Usage tab's cache columns will show it.
- Note: caching has a ~1024-token minimum prefix; short conversations may not benefit, which is
  fine — the win is on exactly the long tool-heavy loops that cost the most.

### 3. Make eval runs a deliberate purchase, not a habit

No code needed, just practice (optionally enforce with a small guard):

- Each full `npm run eval:grounding` run ≈ $5–15 of real API calls. Run the full suite before
  merging assistant-behavior changes, not on every iteration while developing.
- For day-to-day iteration, run a subset (vitest's `-t` filter selects scenarios by name), or
  add an `EVAL_ONLY=<fixture-name>` env var to `server/src/eval/grounding.eval.ts` mirroring
  the existing `EVAL_REPEAT` pattern.
- Optional guard: have the eval print an estimated cost + scenario count and require
  `EVAL_CONFIRM=1` (or a `--yes` flag) before running the full suite.

## What NOT to change

- **Don't shrink `MAX_HISTORY_MESSAGES` (24) back down.** Raw WhatsApp turns are short — the
  whole window is ~1–4k tokens and it's what keeps the assistant from forgetting things said
  ten messages ago (the rolling summary only regenerates every 8 messages, so a smaller window
  would leave dead zones). History between messages is not the cost driver; tool results within
  one message's loop are. If it IS changed anyway, `RAW_HISTORY_WINDOW` in
  `server/src/services/conversationSummary.ts` must change with it (they're deliberately
  duplicated), and the README's stale "12 messages" claims should be fixed at the same time.
- **Don't turn off prompt caching or lower its TTL as a "fix".** The big cache-read numbers in
  the console are the 90% discount being applied, not waste. Removing caching would multiply
  input cost by ~10.
