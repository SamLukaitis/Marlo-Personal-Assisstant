# Real-person alerts bypass the importance filter entirely

## Status

- [ ] Not started — investigated 2026-09-19, root cause confirmed, no fix applied yet.

## Background (why this exists)

Jake's tester had "ping me when a real person emails" enabled in Settings and started getting a
WhatsApp ping for every single inbound email — including obvious marketing mail (Pinterest,
Babbel, a JetSMART survey). Looked at first like the "importance filter" had regressed during the
recent onboarding rewrite. It hadn't: diffed every onboarding-era commit
(`git diff 032677f..HEAD`) against `alerts.ts`, `importantEmailAlerts.ts`,
`importantEmailClassifier.ts`, `scheduler.ts`, `reconciliation.ts`, and
`onboardingAlertSuppression.ts` — zero differences. Onboarding never touches this code.

## Root cause

There are two separate, complementary notification features that split inbound mail by one regex,
[`AUTOMATED_SENDER_PATTERN`](../server/src/services/hub.ts#L458-459):

```
/no-?reply|notifications?@|newsletter|updates?@|do-?not-?reply|automated|mailer-daemon/i
```

- **Matches → automated bucket** → [`importantEmailAlerts.ts`](../server/src/services/importantEmailAlerts.ts)
  runs it through an LLM classifier (`importantEmailClassifier.ts`) and only alerts on 8 narrow,
  genuinely useful categories (flight change, delivery notice, invoice due, security alert, etc.).
  Real content filtering.
- **Doesn't match → assumed "a real person"** → [`alerts.ts`](../server/src/services/alerts.ts)
  (`checkForNewImportantMessages`, the "ping me when a real person emails" toggle in Settings)
  pings on **every** one, with **zero** content filtering. This was true from the moment this file
  was written (`dbe4af0`, 2026-08-02) — it has never done importance filtering, only sender-pattern
  exclusion. Confirmed by reading the original diff.

The bug: modern marketing senders don't use classic automated-looking addresses
(`noreply@`, `newsletter@`, etc.), so Pinterest/Babbel/JetSMART fall through the regex and land in
the "real person, always worth pinging" bucket instead of the classifier's bucket — bypassing
importance filtering entirely even though this mail is obviously not from a person.

Confirmed via the actual WhatsApp message format, which only `alerts.ts` produces
(`server/src/services/alerts.ts:71-75`):

```
📬 {name}, {sender} emailed you: "{subject}"
{snippet}
```

## Why this only just became visible

The "real person" toggle (`realtime_alerts_enabled`) is opt-in and off by default — this gap in
`AUTOMATED_SENDER_PATTERN` has probably always existed but went unnoticed until a tester actually
turned the toggle on.

## Options to fix (not decided yet)

1. **Broaden `AUTOMATED_SENDER_PATTERN`** to catch more marketing/promotional senders (e.g. common
   ESP domains like `mailchimp`, `sendgrid`, `klaviyo`, or a `List-Unsubscribe` header check).
   Simple, but it's a regex arms race — will always lag new senders, and per
   [[avoid-fuzzy-heuristics-prefer-simplicity]] guidance, heuristic pattern-matching that silently
   misroutes is exactly the kind of "smart guessing" to be wary of expanding indefinitely.
2. **Route the "real person" bucket through the same importance classifier too**, instead of
   assuming non-automated == always worth pinging. Removes the two-bucket assumption that caused
   this — anything not caught by the cheap regex still gets a real content check instead of a free
   pass. Costs an extra LLM call for real-person mail, but `alerts.ts` is already gated
   off-by-default and per-check capped (`MAX_ALERTS_PER_CHECK`), so volume is bounded.
3. **Check `List-Unsubscribe` / `Precedence: bulk` headers** (if available from the mail provider)
   as a cheap, robust automated-sender signal instead of/alongside the regex — most marketing
   platforms set these regardless of the From address, which is exactly the case the current regex
   misses.

Option 2 is closest to "why does this feature exist" (real content filtering, not address
pattern-matching) and would make the two features properly complementary again rather than one
being a filtering bucket and the other being an unfiltered fallback. Worth discussing with Jake
before picking — this changes behavior/cost, not just a bug fix.

## What NOT to change

- Don't touch onboarding — confirmed unrelated, and Jake is happy with onboarding as-is.
- Don't change `importantEmailAlerts.ts`'s classifier categories — those are working as intended;
  this is purely about mail leaking around the classifier, not the classifier being wrong.
