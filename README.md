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
| **WhatsApp** | Message your assistant on WhatsApp via Meta's official Cloud API — a compliant bot channel, restricted to a phone-number allowlist you control |
| **Safety** | The assistant can create email **drafts**, archive mail, and manage your **own** calendar — but can never send email or invite other people to an event. Archiving is fully reversible (mail is never deleted, just removed from the inbox) |

**About the WhatsApp integration**: it's deliberately built as a *new channel to message your
assistant*, not a reader of your existing personal WhatsApp chats — there's no compliant API
for that (the only way to read personal chats is an unofficial library that violates
WhatsApp's Terms of Service and risks an account ban; see the setup section below for why we
went this route instead). The provider layer is built so new sources can be added later
without touching the UI or assistant logic.

## Planned (not yet built)

- **WhatsApp image/document ingestion** — e.g. sending a photo of a boarding pass so the
  assistant can log the trip. Today the webhook only handles text messages; photos/documents
  sent to the WhatsApp number are currently ignored. Would need: downloading the media from
  Meta's Graph API, running it through Claude's vision to pull out structured fields (dates,
  airports/countries), and a table to store it in.
- **Travel day tracker** (e.g. "how many days have I spent in the EU this year?") — depends on
  the above being built first, since it needs somewhere to pull entry/exit dates from. The day
  math itself should be done in code once dates are stored, not estimated by the model from
  raw text.
- **Slack, iCloud sync** — no connector built yet.

## Architecture

- `server/` — Express + TypeScript API.
  - `src/providers/google.ts`, `src/providers/microsoft.ts` — per-provider OAuth + data access (mail, calendar, Teams chat, Drive/OneDrive, contacts)
  - `src/providers/local.ts` — local filesystem search, no OAuth; folders are configured on the Setup page and stored in SQLite
  - `src/providers/news.ts` — free public RSS headlines (BBC feeds), no API key needed
  - `src/providers/whatsapp.ts` — Meta Cloud API client (send message, verify webhook signature/handshake)
  - `src/services/hub.ts` — merges results across all connected accounts (and local folders); the UI and the AI only talk to this layer
  - `src/services/briefing.ts` — builds the daily briefing (gathers real data, then has Claude write it up); cached once per day in SQLite
  - `src/ai/assistant.ts` — Claude (Anthropic SDK) with tools: messages, calendar, Teams chats, files, contacts, archive/labels, memory
  - `src/routes/whatsappRoutes.ts` — the public webhook (`GET`/`POST /webhooks/whatsapp`) Meta calls; reuses the same assistant engine as the web chat
  - SQLite (`server/data/app.db`) stores account tokens, local folder paths, briefings, memory notes, WhatsApp conversation history, and your assistant settings
- `client/` — React + Vite. Pages: Assistant (chat + daily briefing), Inbox, Chats, Calendar, Files, Setup.

## Safety boundaries (by design)

- **Never sends email** — only ever creates drafts; you review and hit send yourself.
- **Never invites people to calendar events** — event creation/editing is personal-only, even though the assistant can otherwise fully manage your calendar (create/reschedule/delete).
- **Archiving is non-destructive** — "archive" only removes the inbox label; nothing is ever deleted.
- **The morning briefing is grounded** — it's written by Claude, but only from real data the app fetched (your actual unread mail, actual calendar, actual RSS headlines). It's explicitly instructed never to fill in a section using general knowledge — if you enable news, the briefing shows real fetched headlines, not invented ones.
- **WhatsApp is allowlisted and signature-verified** — only phone numbers you explicitly add on the Setup page get a response; every other sender is silently ignored. Every webhook request's HMAC signature is verified against your Meta app secret before anything is processed, so a spoofed payload claiming to be from an allowed number is rejected too. Without `WHATSAPP_APP_SECRET` set, the webhook refuses to process anything at all rather than trusting unverified requests.

## Cost efficiency

The assistant (`server/src/ai/assistant.ts`) is built to keep API spend down without adding
extra round-trips to do it:

- **Model routing (Haiku vs. Sonnet)** — every message is routed to a cheap tier
  (`claude-haiku-4-5`, default `ASSISTANT_MODEL_SIMPLE`) for lookups and summaries ("what's
  unread", "summarize my emails", "any new Teams messages") or a richer tier
  (`claude-sonnet-5`, default `ASSISTANT_MODEL_COMPLEX`) for drafting, planning, comparisons,
  or anything needing judgment. The choice is made by matching keywords in the latest message
  — no extra "classifier" API call, since that would itself cost tokens and add latency for a
  decision this cheap to make locally. Unmatched phrasing defaults to the richer tier rather
  than the cheapest one. Extended thinking is only used on the richer tier, since simple
  lookups don't benefit from it.
- **Prompt caching** — the tool definitions and system prompt (persona, connected accounts,
  local folders, memory notes) are marked as cache breakpoints with a 1-hour TTL. Since these
  are identical across most calls in a session, repeat calls read from cache instead of paying
  full price for the same ~15 tool schemas and context every single turn. Confirmed live: on
  `claude-sonnet-5` the first call writes the cache and later calls in the same conversation
  read from it. On `claude-haiku-4-5` caching doesn't currently kick in — Haiku models need a
  larger minimum prompt size before a cache breakpoint is written, and this app's tools +
  system prompt fall under that threshold. Haiku calls still cost less overall (cheaper
  per-token rate, no thinking tokens), just without the extra caching discount on top.
- **Bounded memory, not one long conversation** — WhatsApp and web chat both cap how much raw
  conversation history gets resent per call (`MAX_HISTORY_MESSAGES`, currently 12 messages)
  instead of replaying an ever-growing transcript. Durable facts are expected to live in
  **memory notes** (the `remember` tool) rather than in raw history — that's effectively an
  Obsidian-style model: small, atomic, addressable notes recalled on demand, instead of a
  vector database or embedding search (which would itself cost an API call per lookup). The
  system prompt only injects the most recent 40 notes, so the vault can keep growing over
  months of use without the prompt growing forever with it — the full note list is still
  available (and manageable) on the Setup page.

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

### 3. WhatsApp (optional — message your assistant, not a reader of existing chats)

This uses Meta's official **WhatsApp Cloud API** — a compliant bot channel. It does **not**
give the assistant access to your existing personal WhatsApp conversations; you get a new
number to message *it* on. Skip this section entirely if you don't want it — the Setup page
just shows "Not configured".

1. [Meta for Developers](https://developers.facebook.com/) → **My Apps** → **Create App** →
   choose the "Business" type.
2. In your app's dashboard, **Add Product** → **WhatsApp** → **Set up**.
3. On the WhatsApp → **API Setup** page you'll immediately get a **free test phone number**
   (no business verification needed) plus a **temporary access token**. Copy:
   - The **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - The **temporary access token** → `WHATSAPP_TOKEN` (expires in 24h — generate a
     **permanent token** later via System Users under Business Settings once you're happy it works)
4. Same page → **To** field → **Manage phone number list** → add your own phone number as a
   test recipient (the test number can message up to 5 approved recipients — plenty for
   personal use).
5. Make up any random string for `WHATSAPP_VERIFY_TOKEN` — you'll enter this same value in
   Meta's dashboard in step 8.
6. App dashboard → **App Settings → Basic** → copy **App Secret** → `WHATSAPP_APP_SECRET`.
7. **Expose your local server publicly** — Meta cannot call `localhost`. For testing, run a
   tunnel: [ngrok](https://ngrok.com/) → `ngrok http 4000` → copy the `https://...ngrok...`
   URL it gives you. (For always-on use rather than just testing, you'd deploy the server
   somewhere with a real public URL instead of tunneling.)
8. Back in WhatsApp → **Configuration** → **Edit** webhook:
   - Callback URL: `<your ngrok/public URL>/webhooks/whatsapp`
   - Verify token: the same string you put in `WHATSAPP_VERIFY_TOKEN`
   - **Verify and save**, then subscribe to the **messages** webhook field.
9. Restart the server (env changes need a restart, unlike code changes) and add your own
   phone number to the **allowed numbers** list on the Setup page — WhatsApp format, e.g.
   `447911123456` (country code, no `+` or spaces; entering it with `+`/spaces is fine too,
   it gets normalized automatically).
10. Message your test number on WhatsApp — you should get a reply from your assistant.

> Test numbers work indefinitely for personal use with up to 5 approved recipients — you
> don't need Meta Business verification unless you want a dedicated permanent number.

### 4. Anthropic API key (required for the assistant)
Get a key at [console.anthropic.com](https://console.anthropic.com/) and put it in
`server/.env` as `ANTHROPIC_API_KEY`.

### 5. Environment files

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Fill in the values from the steps above in `server/.env`.

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
4. **WhatsApp** (if configured) → message your test number directly — same assistant, same tools.

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
- **WhatsApp needs a public URL** — the free ngrok URL changes every time you restart the
  tunnel, so you'll need to update the webhook URL in Meta's dashboard each time unless you
  use a paid static ngrok domain or deploy the server somewhere permanent.
- **WhatsApp doesn't read your existing chats** — it's a new number/contact you message, not
  a window into conversations you already have with other people (see the note near the top
  of this README on why).
- **Temporary access tokens expire in 24h** — fine for initial testing; generate a permanent
  token via a System User in Meta Business Settings for anything longer-lived.
- **Model routing is a keyword heuristic, not a learned classifier** — occasionally a complex
  request phrased simply (or vice versa) will land on the "wrong" tier. It's biased to default
  to the richer tier when unsure, so the failure mode is "cost a bit more," not "answer badly."
- **Conversation history is capped, not summarized** — once a conversation passes 12 messages,
  older turns are dropped rather than condensed. Anything worth keeping needs to be an
  explicit memory note (the assistant is instructed to do this proactively, but it's not
  guaranteed for every fact).

## Adding a new source later

Add a provider module in `server/src/providers/` (OAuth + list/search functions), route it
in `server/src/services/hub.ts`, and register its card in `/api/providers` (skip this last
step for non-account sources like local files). The inbox, chats, calendar, files, and
assistant tools pick it up automatically.
