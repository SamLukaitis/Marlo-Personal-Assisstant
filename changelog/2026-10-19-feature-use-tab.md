The Portal has a new Feature use tab showing what people use Marlowe for, and what they don't.

## Why

More people are getting the number. Usage → Recent calls shows costs (and the text of admins'
own messages only), but not which features people actually reach for. We wanted a simple view of
where to focus.

## What changed

- Each time Marlowe answers a message, it records which tools that answer used and how many times
  (`feature_messages` and `feature_message_tools` tables). Only tool names are saved, never what
  anyone said, so it's kept for every user, not just admins.
- It also counts:
  - web searches, from Anthropic's usage report, since web search is a server tool;
  - the real tool behind a confirm button (e.g. `send_email` when Marlowe asks "Send it?");
  - photos or documents sent on WhatsApp (`document_sent`);
  - message types Marlowe can't read yet, like voice notes, stickers and video (`unsupported:<type>`),
    which never reach the assistant.
- Tools are grouped into areas (Email, Calendar, Reminders, Memory & people, Trips, flights &
  hotels…) in `server/src/services/featureUsage.ts`. A message that used no tools, or only
  "helper" tools like buttons and reactions, counts as "Just conversation". A test fails if a new
  tool is added without an area, so add new tools to `TOOL_AREAS` there.
- Portal → Feature use (`GET /api/portal/feature-usage`) shows:
  - messages answered, people, and the share of messages that used a feature;
  - a bar for each area, with messages and people;
  - areas and tools nobody used in the range, marking tools this server isn't set up for (no Maps
    key, no Shortcut) so they don't read as unpopular;
  - a table by tool, with uses, messages, people and last used;
  - a table by person, showing their three busiest areas.
- 7, 30 or 90 days, and a "Leave out admins" checkbox so our own testing doesn't drown out
  everyone else's.
- Deleting a user deletes their rows too.

Counting started with this change, so there's nothing from before it. Joyce isn't included yet;
see `feature-to-do/feature-use-followups.md`.
