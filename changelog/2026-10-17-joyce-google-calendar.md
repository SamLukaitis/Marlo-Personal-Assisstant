Joyce can now work with Google Calendar: family members connect their own, Joyce can make a shared family calendar that new events go on, and anyone in the family can ask what's on or have Joyce add, move or delete events.

(Merged with Joyce's built-in calendar on 2026-10-18 so each family only ever has one calendar; see
`changelog/2026-10-18-joyce-one-calendar-per-family.md`.)

## What changed

A family member says something like "connect my Google Calendar". Joyce replies with a link, which
works once and only for the next ten minutes. The link takes them through Google's normal sign-in
and lands on a short "connected" page. From then on, anyone in the family can ask Joyce:

- what's on, for one person or everyone ("what's everyone doing Saturday?")
- to make a family calendar (see below)
- to add something. It goes on the family calendar if there is one, unless they ask for a
  person's own calendar ("put swimming on Nia's calendar Thursday at 5", "put it in my calendar")
- to move, rename or delete an event

## The family calendar

"Make us a family calendar" creates a new Google calendar (called "Family" unless they name it)
in the Google account of whoever asked. Joyce shares it, with edit rights, with every member who
has connected Google, and adds it to their calendar list, so it appears in their Google Calendar
app as its own layer. Members who connect later get it automatically. Everyone's personal calendar
stays untouched unless someone asks for it.

Google has no calendar that belongs to a group, so it has to live in one person's account, which causes a few
edge cases:

- If a member leaves the family, they're unshared from it.
- If the person whose account holds it leaves, Joyce stops using it, because otherwise they'd keep
  seeing everything the family adds after they've gone. The family can ask for a new one.
- If that person only *disconnects* Google, the family calendar keeps working for everyone else,
  but nobody new can be added to it until they reconnect.

If the family calendar didn't get added for someone, they can ask Joyce to add them to it.

Personal calendars are still read, so Joyce can answer "is Sam free on Saturday?"

Times are read and written in each person's own Google Calendar time zone, so "3pm" means 3pm
where that person is, not server time. Events Joyce adds say "Added by Joyce for <name>" in their
notes, so it's clear later how they got there.

"Disconnect my Google Calendar" removes your own connection; nobody can disconnect someone else's.
Leaving the family disconnects it automatically, because the family shouldn't keep access to the
calendar of someone who has left.

## How it's built, and why

- **Separate from Marlowe's Google code.** Joyce isn't allowed to import Marlowe's modules (a test
  enforces this, because doing so would put Marlowe's database within reach). So she has her own
  small Google module (`server/src/joyce/googleCalendar.ts`). It uses the same Google OAuth app as
  Marlowe but has its own callback URL, `/joyce/google/callback`.
- **Calendar only.** Joyce asks Google for calendar access and the person's email address, nothing
  else: no Gmail, Drive or contacts. The whole family can use whatever is connected, so it's kept
  to what a family assistant needs. To create and share the family calendar she needs Google's
  "calendars this app created" and "calendar sharing" permissions. Google has no narrower way to
  share only the calendar an app made, so the sharing permission technically covers every calendar
  the person owns. Joyce's code only ever changes the family calendar's sharing.
- **Tokens live in the family's own database file**, encrypted with that family's key like
  everything else Joyce stores.
- **Families stay sealed off from each other.** As with Joyce's other tools, none of the calendar
  tools takes a family or phone number. A person is picked by name from this family's members.
  An event is referred to through this family's own list of connected accounts, so nothing the
  model writes can reach another family's calendar.
- **The connect link isn't written by the model.** The reply carrying it is fixed text, sent the
  same way as the "leave family" warning, so the link can't be mistyped. Before anyone connects,
  the reply also warns them that the whole family will be able to see and change their calendar.
- The link is single-use, expires after ten minutes, and must be finished in the same browser
  that opened it. Cancelling on Google's screen leaves the link working.
- Event titles can come from invitations sent by people outside the family. Joyce is told to treat
  them as information only, and she sees only titles, times and places, never event descriptions.

## Before it works in production

1. In Google Cloud Console, add `https://<server>/joyce/google/callback` to the OAuth client's
   authorised redirect URIs.
2. Add the `calendar.calendarlist`, `calendar.app.created` and `calendar.acls` scopes to the OAuth
   consent screen. If the app is still in "Testing" mode, each person connecting must be listed as
   a test user. Once the app is published, Google may ask for verification because of these scopes.
3. No new environment variables are needed (`JOYCE_GOOGLE_REDIRECT_URI` is optional).
