# Feature Brainstorm Follow-ups — 2026-08-24

Raised in a single brainstorming session; decomposed here rather than designed all at once
(seven largely-independent threads bundled into one ask). Cross-references
[[2026-08-20-founder-task-split]]. Two of these are flagged as trust-model decisions, not
ordinary feature work — see below.

## Status of each thread

1. **Two-way calendar smarts — send invites to other people.** ⚠️ **Trust-model reversal, not
   started.** `create_calendar_event`'s tool description currently states "This never invites
   other people" as a deliberate safety guarantee, and the homepage's trust section pitches this
   to users ("It can't send mail as you" / drafts-only framing extends conceptually to not
   inviting others either). Needs an explicit, conscious decision — not a feature to slide in —
   before any design work starts. Revisit deliberately when ready.

2. **Send email directly from WhatsApp (draft → show user → confirm → send).** ⚠️ **Trust-model
   reversal, not started.** Same category as #1 — the app's stated design and homepage pitch is
   "drafts only, you always press send." A confirm-before-send flow is a real middle ground worth
   considering (it's not full autonomy), but it's still a different guarantee than what's
   currently promised, so it needs the same explicit sign-off before design work starts.

3. **Deeper file understanding / cross-referencing** (e.g. a flight confirmation email matching
   an uploaded boarding pass, proactively surfacing the connection). ✅ **In progress** — matches
   Track 2 ("Retrieval Polish") from the founder task-split roadmap, which already flagged
   "better cross-referencing across documents/checkins/chat history" without designing it.
   Picked as the first of the two independent design efforts to work through now.

4. **Proactive memory surfacing** (the assistant unprompted brings up something it remembers,
   not just passively holding it as context). ✅ **In progress** — picked as the second design
   effort, right after #3.

5. **Smarter proactive email scanning** ("something important showed up"). **Not started.**
   Partially exists today: `alerts.ts` already polls every few minutes and pings WhatsApp, but
   "important" is currently a pure deterministic filter (real person vs. automated sender regex),
   not a qualitative judgment. Upgrading "real person" to "actually important" is a real design
   question — likely needs either a cheap LLM triage pass or a richer deterministic heuristic —
   and inherits the existing hardcode-vs-LLM cost tension. Worth its own design pass later.

6. **Algorithm to detect what's "worth remembering."** ✅ **Already solved, mostly.** The
   `remember` tool is always available to the assistant every turn, with the instruction to call
   it "whenever the user tells you something worth recalling later, without waiting to be asked"
   — the judgment is already delegated to the model in real time, not a separate classifier. The
   open question isn't "how do we build this" but "is it catching the right things, too much, or
   too little" — worth a lightweight check-in once real usage data exists, not a design project.

7. **Efficient memory that doesn't soak up API calls.** ✅ **Already solved at current scale.**
   Memory notes are capped at the 40 most recent, flat-injected into the system prompt every
   turn — cheap and simple. The "feel like it's talking to a human" part of the ask is really
   thread #4 (proactive surfacing), not a storage-cost problem — the cost side is already handled.

## Next step

Threads #3 and #4 are being designed now (via the normal brainstorming → spec → plan flow, with
first-draft approach options drafted by an external model to save on this session's own token
budget, then reviewed/filtered before being presented). Threads #1 and #2 stay parked until
there's a deliberate conversation about changing the app's stated trust guarantees. Thread #5 is
a real design candidate for whenever this list gets revisited. Threads #6 and #7 need no design
work right now.
