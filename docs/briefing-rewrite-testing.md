# Daily briefing rewrite — what changed and how to test it

**On staging since 30 Sep 2026** (commit `308366b`, deploy `7e831b4f`).
Staging: https://startupwjake-staging.up.railway.app — sign in with your admin account.

Nothing in here has gone to production. The live WhatsApp number still sends the old briefing.

---

## The short version

The briefing used to read like a status page. It had a fixed section order, `Inbox:` / `Calendar:`
labels, and three lines that printed whether or not there was anything in them — so a quiet day
produced a message that reliably said nothing, three times over:

> Inbox: none unread. Calendar: nothing scheduled today. Needs attention: nothing pending.

It now writes as prose, leads with whatever actually matters, drops anything empty, and on a
genuinely quiet day sends a short warm check-in instead:

> Evening Margaret, nice and quiet tonight — nothing on your calendar, no unread mail, nothing
> waiting on you. Light rain in Bristol, 13°C, so nothing pressing either way. Have a good evening
> and sleep well.

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
- **90-word hard limit.** The first version of the rewrite overshot to 102 words by trying to
  mention everything, including a bank statement. The instruction now says explicitly that a busy
  day means *choosing*, not compressing. Ten test profiles now land between 19 and 70 words.

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

- See the **word count**. If a briefing goes over the 90-word limit the card shows **OVER 90** —
  that's a problem worth telling me about.
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

## Two things still outstanding

**1. You didn't get a briefing on your real number.** We looked into this separately. Production is
running fine, but three of the six conditions that decide whether it sends skip *silently*, so I
couldn't tell from the logs which one stopped you. Most likely the "Send it to me on WhatsApp"
checkbox is off. There's also a genuine bug: unticking "Show my daily briefing" on the Settings page
**hides** the WhatsApp checkbox without turning it off, so someone can keep receiving messages with
no visible way to stop them. Neither is fixed yet — say the word.

**2. The evening email digest is untouched.** You said both were annoying; this work only covers the
morning briefing. The digest still uses its hardcoded 📬 bullet-list format, and its real controls
(daily summary vs. instant, and what time) are only reachable by asking Marlowe in chat — they're not
on the Settings page at all.
