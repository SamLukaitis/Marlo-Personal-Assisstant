Admins can now send every Marlowe user a "What's new in Marlowe" message on WhatsApp from the Portal, and anyone can reply "stop updates" to opt out.

## What changed

- **Portal → Send Update** (`client/src/pages/PortalPage.tsx`, `UpdatesTab`). Write the update (up
  to 900 characters), press "Send me a test" to get it on your own WhatsApp, then "Send to
  everyone". It shows how many numbers it goes to, how many it reached and how many failed, keeps
  a list of past updates, and has "Retry failed", which only re-sends to the numbers that didn't
  get it (for a week, while the delivery records are kept).
- **Who gets it** (`server/src/services/announcements.ts`): every Marlowe user with a WhatsApp
  number, except anyone who has opted out and the WhatsApp Simulator's test users. Joyce families
  aren't included.
- **How it's sent.** People who messaged Marlowe in the last 24 hours get a normal message
  headed *What's new in Marlowe*, ending "Reply "stop updates" if you'd rather not get these."
  Everyone else gets the new `marlowe_whats_new` template. That template is **MARKETING**, not
  utility: Meta counts feature announcements as promotional, and sending them under the utility
  templates that alerts and briefings use (`marlowe_alert`, `marlowe_digest`) risks Meta pausing
  those. Marketing messages cost a little more per message than utility ones, and since April 2025 Meta
  hasn't delivered marketing templates to US (+1) numbers, so a +1 user only gets an update inside
  the 24-hour window.
- **Opting out.** Replying "stop updates" on its own is handled without the model
  (`server/src/services/chatDispatch.ts`, like "help"), sets the `product_updates` setting to off,
  and confirms. "start updates" turns them back on. Briefings and alerts are unaffected. The
  assistant is told about it, so "can you stop sending me these" gets pointed at the same reply.
- **History.** Each update is saved in the person's chat history like a briefing, so a reply such
  as "tell me more about that" has context. Past updates are stored in a new `announcements` table.

## Before the first send

Create the template once and wait for Meta to approve it (usually minutes to a day):

```bash
cd server
npm run whatsapp:templates -- 1574262347469069 --create   # submit
npm run whatsapp:templates -- 1574262347469069            # check: should say APPROVED, MARKETING
```

Until it's approved, people outside the 24-hour window will fail and show up in "failed" (and
in the Portal's Logs). Use "Retry failed" once it's approved.
