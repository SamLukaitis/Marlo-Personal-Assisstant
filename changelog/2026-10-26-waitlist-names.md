Waitlisted people are now asked their name on WhatsApp, so the Waitlist shows who is who, and the name carries into onboarding.

**Why:** the Settings → Waitlist section only showed phone numbers, so there was no way to tell who had asked for access before sharing the Marlowe number more widely.

**What changed**
- An uninvited number's first message now ends with "what's your name?". Their next message is stored as the name (checked with `isPlausibleName`). If it isn't name-shaped they are asked once more, then logged without a name. After that they get the usual short reminder.
- Settings → Waitlist shows the name next to the number.
- On approval (`POST /api/admin/invites`) the waitlist name is copied to `invited_phones.name`. When that number first messages as an invited user, the registration flow skips "What would you like me to call you?" and goes straight to the email question. Numbers an admin invites directly (no name) are still asked.
- New nullable `name` columns on `waitlist_requests` and `invited_phones` (added by migration in `db/store.ts`). `waitlist_requests.name`: NULL = still asking, "" = gave up.

**Existing waitlist:** numbers already on the waitlist when this shipped are never asked their name (the migration sets their `name` to ""), so only new incoming people are. Admins can see them without a name.
