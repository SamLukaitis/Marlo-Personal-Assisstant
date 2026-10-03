# Daily briefing rewrite — what changed and how to test it

**The voice change is live in production** as of 3 Oct 2026 (master `0a9beb6`) — the live WhatsApp
number now sends the new briefing.

**The Briefing Lab is staging only** (`c98e6d1`): https://startupwjake-staging.up.railway.app — sign
in with your admin account. It's hidden in production on purpose.

This is not finished. See "Still to do" at the bottom.

---

## The short version

The briefing used to read like a status page. It had a fixed section order, `Inbox:` / `Calendar:`
labels, and three lines that printed whether or not there was anything in them — so a quiet day
produced a message that reliably said nothing, three times over:

> Inbox: none unread. Calendar: nothing scheduled today. Needs attention: nothing pending.

It now writes one short paragraph of prose, talks about **people rather than email subject lines**,
leads with whatever actually matters, and drops anything empty:

> Morning, Jake. Light rain in Lisbon today, topping out around 19°C. Sarah's still chasing that
> overdue invoice, and Tiago's waiting on a quote for the Porto job. You've got the dentist at 2 and
> a call with Priya at 4:30, plus a flight to Amsterdam Monday evening — rest can wait.

On a genuinely quiet day it sends a short warm check-in instead of a list of nothings:

> Evening, Jake. Nothing came up today and nothing's sitting there needing you, so it's a genuinely
> clear one. Good chance to actually switch off tonight. Sleep well.

There is also a new **Briefing Lab** page for looking at ten different users' briefings at once,
without needing ten accounts or ten mornings.

---

## What actually changed

### 1. The voice

- **Prose, not labels.** No `Inbox:`, no headings, no bullets, no emoji.
- **Leads with what matters.** The old version always went Location → Weather → Inbox → Calendar →
  Needs attention → Markets → News, so a flight tomorrow landed third because calendar came third.
  It now opens with whatever is most worth acting on.
- **Empty sections disappear.** Previously Inbox, Calendar and Needs-attention always got a line
  each, even when the answer was "nothing".
- **Quiet days get a different message, not a shorter one.** Whether a day is quiet is decided in
  code (no mail, nothing on, nothing awaiting a reply), so it's reliable rather than a judgement
  call the model might get wrong.
- **Talks about people, not subject lines.** This was the main complaint and it took two passes.
  "Sarah's still chasing that overdue invoice" — not `"Invoice 2291 overdue" from Sarah Whitfield`.
  It never quotes a subject line, never gives a count of unread mail, names at most two things, and
  describes the shape of the rest ("rest can wait", "nothing else urgent").
- **Aim 45 words, hard stop 70**, down from 100. Earlier drafts overshot their own stated limit by
  trying to be complete, so the instruction now says a busy day means *dropping* things, not writing
  tighter. Across 30 test renders the mean is 45 words and nothing exceeds 70.
- **It won't invent jobs for you.** An earlier draft offered "maybe sort your packing" and "a good
  chance to get ahead on admin" off facts that said no such thing. That's now explicitly banned.

### 2. Greetings now match the time of day

You asked for "sleep well" — which is an evening line, but the briefing defaults to 07:30. The
model is now told the user's own local send time, so:

- 07:30 → "Morning Jake…"
- 21:00 → "Evening Margaret… sleep well."
- 22:30 → "Evening Kemi… Sleep well." (verified on the night-shift profile)

If the time makes a sign-off awkward it leaves it off rather than guessing.

### 3. Two bugs fixed along the way

- **Raw email addresses were reaching the message.** The first test run produced
  "accounts@supplier" in the middle of a sentence. The briefing was handing the model raw `from`
  fields, while the evening email digest has always cleaned them up first. Now both do.
- **Dates read like a machine.** The model was given a raw timestamp
  (`2026-10-02T19:15:00+02:00`) and had to work the weekday out itself. It now gets
  "Friday 2 Oct at 19:15" as a fact, so it can say "Friday evening" without guessing.

### 4. Nothing about *when* it sends has changed

Same schedule, same on/off switch, same once-a-day rule. This was a content and tone change only.

---

## How to test it tomorrow

### A. Look at ten users at once (start here — 2 minutes)

This is the fastest way to judge the writing.

1. Go to https://startupwjake-staging.up.railway.app and sign in.
2. Click **Briefing Lab** in the left sidebar. (If you can't see it, see Troubleshooting below.)
3. Click **Render all ten**. It takes a few seconds — it's writing ten briefings.

You'll get ten cards. Each one is an invented person with a different setup:

| Profile | What it's there to test |
|---|---|
| Founder, travelling, everything on | The densest possible day — does it choose, or try to say everything? |
| Retiree, 9pm send, weather only | The quiet-day check-in in the evening — warm, and "sleep well"? |
| Nomad, flight in two days | A quiet day that *still* has a flight to pack for |
| Executive, packed diary | Lots of calendar and a reply backlog — does it lead with the right one? |
| Freelancer, no calendar | Mail but no events — does it avoid "nothing scheduled" as its own line? |
| Brand-new signup | No name, no feeds, nothing connected — worst case for sounding robotic |
| Night shift, 10pm send | A late send time — is the greeting still right? |
| Parent, all-day school events | All-day events mixed with timed ones |
| Trader, 6am, markets-heavy | Does the markets feed take over the whole message? |
| Minimalist, everything off | The absolute minimum — one or two sentences, not an error |

**On each card you can:**

- See the **word count**. Typical is 30–55. The card flags anything over the limit — tell me if you
  see one.
- Click **Show the facts it was given** to see exactly what the model had to work with. Worth doing
  whenever a briefing says something odd: usually the facts explain it.

**Click Scramble** to re-roll all ten with different content. Press it a few times — this is how you
see whether the voice holds up or starts repeating itself.

**The seed box matters.** Every set has a number. If you scramble and hit something that reads
badly, **write the seed down** and send it to me — I can reproduce that exact set. You can also type
a seed in and press **Use seed** to go back to it.

Nothing on this page touches a real account, reads a real mailbox, or saves anything. Every name,
email and headline is invented.

### B. Send yourself a real one on WhatsApp (5 minutes)

This uses your actual mail and calendar, so it's the real test of whether the content is right.

1. Go to **WhatsApp Test** in the sidebar.
2. Leave the dropdown on **"Me — my own account"**.
3. **Type any message first** and send it — for example `hi`. This matters, see the warning below.
4. Click **Send daily briefing**.

It rebuilds your briefing from scratch at that moment and sends it down the real WhatsApp path. Press
it as many times as you like — each press is a fresh build.

> **If you skip step 3** you'll get something that looks broken: one long unbroken line starting
> `[template marlowe_digest]`. That's not a bug. WhatsApp only allows free-form messages within 24
> hours of you last messaging Marlowe; outside that window it has to use a pre-approved template,
> which strips all the line breaks. It's what a real user who hasn't messaged in a day actually
> receives — worth seeing once, but not what you want to judge the writing on.

### C. What to look out for

Good signs:

- A quiet day feels reassuring rather than pointless.
- A busy day names two or three things, not everything.
- The greeting matches the time.
- It never mentions something you can't find in "Show the facts it was given".

Worth flagging to me:

- **Anything it mentions that isn't in the facts.** This is the one serious failure — the model
  inventing an email, an event or a headline. I've pushed hard on this in the instructions but it's
  the thing to watch.
- **OVER 90** on any card.
- A quiet-day message that reads like a list of nothings.
- A wrong or awkward greeting for the time.
- Repetitive phrasing across scrambles (it's told to vary, but see for yourself).

---

## Troubleshooting

**I can't see Briefing Lab or WhatsApp Test in the sidebar.**
Both are admin-only and staging-only. Check you're signed in on staging (not production) with your
admin account. They're hidden entirely on the live site, which is deliberate.

**Render all ten fails with an error.**
The error text shown on the page is the real reason. A missing `ANTHROPIC_API_KEY` on staging is the
likeliest cause; send me the message.

**It sent, but I got nothing on WhatsApp.**
Check the staging number is registered to your staging account under Settings. The simulator sends to
a fake number (`999000…`) and shows the result in the browser, so the transcript on that page is the
source of truth, not your phone.

---

## Still to do

This is not finished. Known gaps, in the order I'd tackle them:

1. **The evening email digest is untouched.** You said both were annoying; only the morning briefing
   has been rewritten. The digest still sends its hardcoded 📬 bullet list with senders and subject
   lines — exactly the format you objected to. It needs the same treatment.
2. **The hidden off-switch bug.** On the Settings page, unticking "Show my daily briefing" *hides*
   the "Send it to me on WhatsApp" checkbox without turning it off. Someone can keep receiving
   messages every morning with no visible way to stop them. This is very likely why users called it
   annoying and couldn't change it.
3. **The digest's real controls aren't in the UI.** Daily-summary-vs-instant, and what time it
   arrives, are only reachable by asking Marlowe in chat. The Settings page just tells people to go
   ask. Anyone who wants *less* rather than *none* has to know that's possible.
4. **Why you got no briefing on your own number.** Three of the six conditions that decide whether
   it sends skip silently, so the logs can't tell you which one stopped you. Most likely the
   WhatsApp checkbox is off. Logging the skip reason would make this answer itself next time.
5. **Tone across more cases.** The lab covers ten setups. Worth scrambling a few more times and
   telling me where the voice still slips.

## A note on what's where

- **Production (master)** has the voice change only — two files, `briefing.ts` and its test.
- **Staging** additionally has the Briefing Lab, the simulator's "Send daily briefing" button, and
  the Google Maps work that hasn't been promoted yet.
- The Briefing Lab and WhatsApp Test pages are gated on an environment flag that isn't set in
  production, so neither appears on the live site.
