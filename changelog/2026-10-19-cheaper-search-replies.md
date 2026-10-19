Replies that use web search should cost up to about a third less, and the Portal now shows what searches really cost.

**What was wrong.** A single "what live music is on in Leeds on Saturday" message cost about $0.27.
Almost all of that ($0.25) was *cache writes*: each turn of the assistant's reply loop marked
everything sent so far, including the web search results, to be cached for one hour. Writing to
the one-hour cache costs twice the normal input price, and those search results are never read
again after the reply is sent.

**What changed.**
- The breakpoint on the latest part of the conversation (only re-read by the next loop turn,
  seconds later) now uses Anthropic's 5-minute cache, which costs 1.25x instead of 2x. The
  breakpoint on earlier history, which the user's *next* message reads back, keeps the one-hour
  cache. For the Leeds example this brings the cache-write part from about $0.25 to about $0.15.
- Each loop turn now logs a `[assistant-usage]` line (tokens, cache reads and writes split by 5m/1h,
  number of searches) so a costly message in the Portal can be traced in the Railway logs.
- `api_usage` records the number of web searches and how many cache-write tokens were 5-minute.
  The Portal's cost estimate now prices those correctly and adds $0.01 per search, which it
  previously left out.
- The search limit stays at 5 per message while we test.
