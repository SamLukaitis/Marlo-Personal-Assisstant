# Personal AI Assistant Hub

One app that links your accounts — email, calendar, documents — and puts a personal AI
assistant in front of all of them. You describe what you want your assistant to be like on
the **Setup** page, connect your accounts, and from then on the assistant is your interface:
ask it to find emails, summarize your day, locate documents, or draft replies.

## What it can do today

| Area | Capability |
|---|---|
| **Google** (per account) | Gmail read/search/archive/labels, Calendar read/write, Drive file search, Contacts search, Gmail draft creation |
| **Microsoft** (per account) | Outlook mail read/search/archive/categories, Calendar read/write, **Teams chat** read/search, **OneDrive** file search, Contacts search, Outlook draft creation |
| **This computer** | Search local folders you add (e.g. Documents, Desktop) by file name — no account or OAuth needed, since the server runs on your own machine |
| **Multiple accounts** | Connect any number of Google + Microsoft accounts; everything is merged into one inbox/calendar/chats/files view and the assistant sees all of them |
| **Morning briefing** | Auto-generated daily summary (unread mail, today's calendar, emails that look like they need a reply) shown at the top of the Assistant page, with an optional news section from free public RSS feeds |
| **Memory** | The assistant remembers facts and preferences you share across conversations (e.g. "the Acme account is my priority business") — view/add/remove notes on the Setup page |
| **Assistant** | Claude with tool-calling: looks up real messages/events/chats/files/contacts before answering; personalized via your Setup-page description |
| **Safety** | The assistant can create email **drafts**, archive mail, and manage your **own** calendar — but can never send email or invite other people to an event. Archiving is fully reversible (mail is never deleted, just removed from the inbox) |

Deliberately **not** included: **WhatsApp** — there's no API that gives compliant access to
personal chats (Business API needs a registered business number; the only way to read
personal chats is an unofficial library that violates WhatsApp's Terms of Service and risks
an account ban). Also not yet built: Slack, iCloud sync. The provider layer is built so any
of these can be added later without touching the UI or assistant logic.

## Architecture

- `server/` — Express + TypeScript API.
  - `src/providers/google.ts`, `src/providers/microsoft.ts` — per-provider OAuth + data access (mail, calendar, Teams chat, Drive/OneDrive, contacts)
  - `src/providers/local.ts` — local filesystem search, no OAuth; folders are configured on the Setup page and stored in SQLite
  - `src/providers/news.ts` — free public RSS headlines (BBC feeds), no API key needed
  - `src/services/hub.ts` — merges results across all connected accounts (and local folders); the UI and the AI only talk to this layer
  - `src/services/briefing.ts` — builds the daily briefing (gathers real data, then has Claude write it up); cached once per day in SQLite
  - `src/ai/assistant.ts` — Claude (Anthropic SDK) with tools: messages, calendar, Teams chats, files, contacts, archive/labels, memory
  - SQLite (`server/data/app.db`) stores account tokens, local folder paths, briefings, memory notes, and your assistant settings
- `client/` — React + Vite. Pages: Assistant (chat + daily briefing), Inbox, Chats, Calendar, Files, Setup.

## Safety boundaries (by design)

- **Never sends email** — only ever creates drafts; you review and hit send yourself.
- **Never invites people to calendar events** — event creation/editing is personal-only, even though the assistant can otherwise fully manage your calendar (create/reschedule/delete).
- **Archiving is non-destructive** — "archive" only removes the inbox label; nothing is ever deleted.
- **The morning briefing is grounded** — it's written by Claude, but only from real data the app fetched (your actual unread mail, actual calendar, actual RSS headlines). It's explicitly instructed never to fill in a section using general knowledge — if you enable news, the briefing shows real fetched headlines, not invented ones.

## One-time setup

### 1. Google credentials (required for Gmail/Calendar/Drive/Contacts)
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. Enable the **Gmail API**, **Google Calendar API**, **Google Drive API**, and **People API**
   (APIs & Services → Library) — People API powers contact lookup ("email Sarah").
3. APIs & Services → Credentials → Create Credentials → **OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:4000/auth/google/callback`
4. Copy the Client ID and Client Secret into `server/.env`.
5. If the OAuth consent screen is in "Testing" status, add each Google account you'll
   connect as a **test user** (Google Auth Platform → **Audience** tab → Test users), or
   Google will block the login.

> **Already connected before this update?** Calendar write, email archiving/labels, and
> contacts search need extra permission scopes. Disconnect and reconnect your account on the
> Setup page once to grant them — Google will show an updated consent screen.

### 2. Microsoft credentials (optional — for Outlook)
1. [Azure Portal](https://portal.azure.com/) → App registrations → New registration.
2. Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*.
3. Redirect URI (type **Web**): `http://localhost:4000/auth/microsoft/callback`
4. Certificates & secrets → New client secret. Copy the app (client) ID and the secret value
   into `server/.env` as `MS_CLIENT_ID` / `MS_CLIENT_SECRET`.

Skip this and the Microsoft card on the Setup page simply shows "Not configured".

### 3. Anthropic API key (required for the assistant)
Get a key at [console.anthropic.com](https://console.anthropic.com/) and put it in
`server/.env` as `ANTHROPIC_API_KEY`.

### 4. Environment files

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Fill in the values from steps 1–3 in `server/.env`.

## Running

```bash
# terminal 1
cd server
npm install
npm run dev

# terminal 2
cd client
npm install
npm run dev
```

Open `http://localhost:5173`:

1. **Setup** → describe your assistant (tone, priorities, context about your businesses) and save.
2. **Setup** → Connect each Google/Microsoft account (repeat for multiple accounts), add any
   local folders you want searchable, and optionally turn on the morning briefing / news.
3. **Assistant** → ask things like:
   - *"summarize my unread emails"* / *"archive everything from Nike"*
   - *"what's my week look like?"* / *"move my 3pm to Thursday"* / *"block out an hour tomorrow for X"*
   - *"find the latest invoice from X"* / *"anything new in Teams?"*
   - *"email Sarah about the meeting"* (it looks up her address for you first)
   - *"remember that the Acme account is my priority business"*

## Known limitations

- **The morning briefing regenerates once per day, on demand** — not a true background cron
  job, since the server only runs when you start it. It generates (and caches) the first time
  you open the Assistant page each day; use Refresh to force an update sooner.
- **"Needs attention" is a heuristic** — unread, older than 3 days, sender doesn't look
  automated. It's not true thread analysis, so it can miss or over-flag things.
- **Contacts search differs by provider** — Google only searches contacts you've explicitly
  saved; Microsoft's `/me/people` also surfaces people you've simply emailed before.
- **The reconnect banner doesn't auto-detect granted scopes** — it just shows whenever any
  account is connected. Reconnecting again after you've already done so is harmless.

## Adding a new source later

Add a provider module in `server/src/providers/` (OAuth + list/search functions), route it
in `server/src/services/hub.ts`, and register its card in `/api/providers` (skip this last
step for non-account sources like local files). The inbox, chats, calendar, files, and
assistant tools pick it up automatically.
