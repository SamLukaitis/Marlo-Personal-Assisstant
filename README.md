# Personal AI Assistant Hub

One app that links your accounts — email, calendar, documents — and puts a personal AI
assistant in front of all of them. You describe what you want your assistant to be like on
the **Setup** page, connect your accounts, and from then on the assistant is your interface:
ask it to find emails, summarize your day, locate documents, or draft replies.

## What it can do today

| Area | Capability |
|---|---|
| **Google** (per account) | Gmail read/search, Calendar read, Drive file search, Gmail draft creation |
| **Microsoft** (per account) | Outlook mail read/search, Calendar read, Outlook draft creation, **Teams chat** read/search, **OneDrive** file search |
| **This computer** | Search local folders you add (e.g. Documents, Desktop) by file name — no account or OAuth needed, since the server runs on your own machine |
| **Multiple accounts** | Connect any number of Google + Microsoft accounts; everything is merged into one inbox/calendar/chats/files view and the assistant sees all of them |
| **Assistant** | Claude with tool-calling: looks up real messages/events/chats/files before answering; personalized via your Setup-page description |
| **Safety** | The assistant can create email **drafts** but can never send — you review and send from Gmail/Outlook yourself |

Deliberately **not** included: **WhatsApp** — there's no API that gives compliant access to
personal chats (Business API needs a registered business number; the only way to read
personal chats is an unofficial library that violates WhatsApp's Terms of Service and risks
an account ban). Also not yet built: Slack, iCloud sync. The provider layer is built so any
of these can be added later without touching the UI or assistant logic.

## Architecture

- `server/` — Express + TypeScript API.
  - `src/providers/google.ts`, `src/providers/microsoft.ts` — per-provider OAuth + data access (mail, calendar, Teams chat, Drive/OneDrive)
  - `src/providers/local.ts` — local filesystem search, no OAuth; folders are configured on the Setup page and stored in SQLite
  - `src/services/hub.ts` — merges results across all connected accounts (and local folders); the UI and the AI only talk to this layer
  - `src/ai/assistant.ts` — Claude (Anthropic SDK) with tools: list/search/read messages, calendar, Teams chats, file search, draft creation
  - SQLite (`server/data/app.db`) stores account tokens, local folder paths, and your assistant settings
- `client/` — React + Vite. Pages: Assistant (chat), Inbox, Chats, Calendar, Files, Setup.

## One-time setup

### 1. Google credentials (required for Gmail/Calendar/Drive)
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project.
2. Enable the **Gmail API**, **Google Calendar API**, and **Google Drive API** (APIs & Services → Library).
3. APIs & Services → Credentials → Create Credentials → **OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:4000/auth/google/callback`
4. Copy the Client ID and Client Secret into `server/.env`.
5. If the OAuth consent screen is in "Testing" status, add each Google account you'll
   connect as a **test user**, or Google will block the login.

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
2. **Setup** → Connect each Google/Microsoft account (repeat for multiple accounts), and add
   any local folders you want searchable (e.g. `C:\Users\you\Documents`).
3. **Assistant** → ask things like *"summarize my unread emails"*, *"what's my week look
   like?"*, *"find the latest invoice from X"*, *"anything new in Teams?"*, or *"draft a
   reply to Sarah's email"*.

## Adding a new source later

Add a provider module in `server/src/providers/` (OAuth + list/search functions), route it
in `server/src/services/hub.ts`, and register its card in `/api/providers` (skip this last
step for non-account sources like local files). The inbox, chats, calendar, files, and
assistant tools pick it up automatically.
