# Personal AI Assistant Hub

One app that links your accounts — email, calendar, documents — and puts a personal AI
assistant in front of all of them. You describe what you want your assistant to be like on
the **Setup** page, connect your accounts, and from then on the assistant is your interface:
ask it to find emails, summarize your day, locate documents, or draft replies.

## Accounts, login, and multi-tenancy

This is a real multi-tenant app: each person gets their own isolated hub (own connected
accounts, own documents, own WhatsApp number(s), own memory/settings) — nobody else's hub can
see your data, and every `/api/*` route is scoped to whoever is logged in.

- **Login = Google or Microsoft sign-in**, not a separate password system. Reuses the same OAuth
  flow already used for connecting a mailbox, but as two distinct intents carried in the OAuth
  `state` param: `login` (identity — creates/looks up your `users` row, issues a session) vs.
  `connect` (attaches an additional Gmail/Outlook account to your hub, requires an existing
  session). Both share one callback route per provider, so nothing extra needed registering with
  Google/Microsoft.
- **Sessions**: an httpOnly cookie holding an opaque random token; only its SHA-256 hash is ever
  stored (`server/src/db/store.ts`'s `sessions` table). 30-day sliding expiration. No
  `express-session` dependency — see the code comment in `store.ts` for why a ~30-line custom
  implementation was chosen over it.
- **Invite-only, no self-serve signup**: a `users` row is only created for an email present in
  the `invited_emails` table. Granting access: `npm run invite -- someone@example.com` from
  `server/` (a tiny CLI script, `server/src/scripts/invite.ts` — no admin UI exists for this
  yet). Someone who isn't invited sees a "not invited yet" state on the homepage.
- **WhatsApp routing**: one shared WhatsApp Business number serves every tenant — each phone
  number registered on the Setup page maps to exactly one user (`user_phone_numbers` table), and
  an incoming message is routed to that user's hub (their accounts, memory, settings) by looking
  up the sender's number, not by a single global allowlist.
- **First deploy / existing single-tenant data**: the multi-tenant migration (in `store.ts`,
  guarded the same way earlier migrations are — checks for a missing `owner_id` column) backfills
  every pre-existing row to one "app owner" account, resolved from the `APP_OWNER_EMAIL` env var
  (defaults to the address that was already connected). That owner is auto-invited as part of the
  same migration so you're never locked out of your own data.

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
| **Documents (from WhatsApp)** | Send a photo or PDF (boarding pass, license, ticket, receipt) — Claude's vision analyzes it once on arrival and the extracted details are saved, so you can later ask things like "when did I fly to Berlin" or "what's the code on my license". If it's a travel document, it also feeds the travel day tracker below automatically. Browse/download/delete what's been saved on the Files page |
| **Location check-ins** | A phone automation (iOS Shortcuts / Android Tasker) posts your coordinates when you land somewhere or cross a border; the server reverse-geocodes it to a country/city and logs it — no WhatsApp round-trip, so it's genuinely automatic. Ask things like "where have I been this month" |
| **Travel day tracker** | "How many Schengen days have I used in the last 180 days?" — computed deterministically in code from the check-in log (day-by-day reconstruction, not model guesswork), which now includes both automatic phone check-ins and dates pulled from boarding passes/tickets sent via WhatsApp. Works for "schengen", "eu", or any specific country name. The Setup page shows a running Schengen 90/180 count and labels each entry by source (phone vs. document) at a glance |
| **Unified search** | One search bar (the **Search** page) that queries your email, Drive/OneDrive/local files, Teams chats, and saved WhatsApp documents all at once, instead of searching each separately |
| **Proactive briefing** | Optionally have the morning briefing pushed to WhatsApp automatically at a time you choose, instead of only generating when you open the web app — with a Schengen day-limit warning appended if you're getting close. Toggle on the Setup page |
| **Real-time alerts** | Optionally get pinged on WhatsApp the moment an email from a real person (not a newsletter/notification) arrives, rather than waiting for the next briefing. Checks every few minutes while the server is running; the first check after enabling just sets a baseline so it won't alert on your entire existing inbox |
| **Safety** | The assistant can create email **drafts**, archive mail, and manage your **own** calendar — but can never send email or invite other people to an event. Archiving is fully reversible (mail is never deleted, just removed from the inbox) |

**About the WhatsApp integration**: it's deliberately built as a *new channel to message your
assistant*, not a reader of your existing personal WhatsApp chats — there's no compliant API
for that (the only way to read personal chats is an unofficial library that violates
WhatsApp's Terms of Service and risks an account ban; see the setup section below for why we
went this route instead). The provider layer is built so new sources can be added later
without touching the UI or assistant logic.

## Encryption at rest

OAuth access/refresh tokens (`accounts` table) and uploaded document files
(`server/data/uploads/`) are encrypted with AES-256-GCM (Node's built-in `crypto`, no extra
dependency) before ever touching disk — see `server/src/services/crypto.ts`. The key lives only
in the `ENCRYPTION_KEY` env var (64 hex chars / 32 bytes, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
to generate one) — never committed to git, never stored in the database itself.

**Still plaintext, deliberately out of scope for now**: WhatsApp conversation history, extracted
document text, and location check-in history. Lower-sensitivity than live account access or the
raw source images, and encrypting every column would make ordinary reads/writes and search much
more invasive to touch — worth revisiting if this grows beyond a handful of trusted users.

**Migration note**: accounts/documents saved *before* this was added are still plaintext on disk
— the read path falls back to the raw value if it isn't valid ciphertext, so nothing breaks, but
those rows only become encrypted once the token next refreshes (automatic) or you reconnect the
account / re-upload the document.

**The real risk to plan around**: if `ENCRYPTION_KEY` is ever lost, the encrypted data becomes
permanently unrecoverable. Store it somewhere durable (a password manager), separate from
backups of the encrypted data itself, from day one — losing the key is equivalent to losing
everything it protects.

## Planned (not yet built)

- **Slack, iCloud sync** — no connector built yet.

## Architecture

- `server/` — Express + TypeScript API.
  - `src/providers/google.ts`, `src/providers/microsoft.ts` — per-provider OAuth + data access (mail, calendar, Teams chat, Drive/OneDrive, contacts)
  - `src/providers/local.ts` — local filesystem search, no OAuth; folders are configured on the Setup page and stored in SQLite
  - `src/providers/news.ts` — free public RSS headlines (BBC feeds), no API key needed
  - `src/providers/whatsapp.ts` — Meta Cloud API client (send message, verify webhook signature/handshake, download media)
  - `src/services/hub.ts` — merges results across all connected accounts (and local folders); the UI and the AI only talk to this layer
  - `src/services/briefing.ts` — builds the daily briefing (gathers real data, then has Claude write it up); cached once per day in SQLite
  - `src/services/documents.ts` — downloads a WhatsApp photo/PDF, runs it through Claude's vision once to extract key facts, and stores both the file and the extracted text. The same call offers an optional `record_travel_movement` tool the model can call if the document clearly shows travel — those get saved as check-ins (source `"document"`, linked back to the document) so they feed the travel day tracker automatically
  - `src/services/geocode.ts` — reverse-geocodes lat/long to a country/city via OpenStreetMap's free Nominatim API
  - `src/services/travelDays.ts` — pure date arithmetic: reconstructs a day-by-day "which country" timeline from check-ins and counts days in a country/Schengen/EU over a date range; no model involved, since day counts need to be exact
  - `src/services/alerts.ts` — polls for unread mail from real people (not automated senders) and pushes a WhatsApp ping for anything new, with a persisted dedup ledger and a first-run baseline so enabling it doesn't alert on your whole existing inbox
  - `src/services/scheduler.ts` — the only long-running part of the app: an in-process interval (every 5 min) that drives both the proactive briefing push and the real-time alert check. Only does anything while the server process is actually running
  - `src/ai/assistant.ts` — Claude (Anthropic SDK) with tools: messages, calendar, Teams chats, files, contacts, archive/labels, memory, saved documents, travel check-ins/day-counting
  - `src/routes/whatsappRoutes.ts` — the public webhook (`GET`/`POST /webhooks/whatsapp`) Meta calls; resolves the sender's phone to a tenant (`resolveOwnerByPhone`), then reuses the same assistant engine as the web chat; branches to `documents.ts` for photo/PDF messages
  - `src/routes/checkinRoutes.ts` — secret-protected `POST /api/checkin` for phone automations (resolves to the app owner — see "Accounts, login, and multi-tenancy"); `checkinReadRoutes` (mounted separately, session-gated) has `GET /api/checkins` and `GET /api/travel-days`
  - `src/routes/searchRoutes.ts` — `GET /api/search` fans a query out to mail/files/chats/documents in parallel and returns them together
  - `src/routes/authRoutes.ts` — both the "log into the app" and "connect a data source" OAuth flows (see "Accounts, login, and multi-tenancy"); `src/routes/meRoutes.ts` — `GET /api/me`, how the client knows who's logged in
  - `src/middleware/auth.ts` — `requireAuth`, gates every `/api/*` route (wired in `index.ts`)
  - `src/scripts/invite.ts` — CLI: `npm run invite -- someone@example.com`
  - SQLite (`server/data/app.db`) stores account tokens, local folder paths, briefings, memory notes, WhatsApp conversation history, saved documents' extracted text, location check-ins, the alert dedup ledger, assistant settings, and the multi-tenant identity tables (`users`, `invited_emails`, `sessions`, `user_phone_numbers`) — every tenant-scoped table carries an `owner_id`; the raw uploaded files themselves live under `server/data/uploads/`
- `client/` — React + Vite. Public `/` is the marketing homepage + sign-in; everything else requires a session (`RequireAuth` + `AuthContext`) and gets the normal sidebar (`AuthedLayout`): `/onboarding` (first-run, connect an account + add a WhatsApp number), `/assistant` (chat + daily briefing), `/search` (one bar across mail/files/chats/documents), `/chats`, `/calendar`, `/files` (also lists saved WhatsApp documents), `/setup` (also shows location check-ins, a Schengen day count, and proactive-briefing/alert toggles).

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

### 4. Location check-ins (optional — automatic travel logging)

This logs where you've been without any WhatsApp round-trip — a phone automation posts your
coordinates straight to the server when you land somewhere or cross a border. Make up any
random string for `CHECKIN_SECRET` in `server/.env` (same idea as the WhatsApp verify token),
then set up one of:

**iOS (Shortcuts app):**
1. Automation tab → **Create Personal Automation**.
2. Trigger: either "Airplane Mode" → **is turned Off** (great for flights — fires the moment
   you land and reconnect), or "Arrive" at a location (for driving across land borders — set
   one per region you might cross into, since Shortcuts has no generic "new country" trigger).
3. Action: **Get Current Location** → **Get Contents of URL**, POSTing to
   `https://<your-server>/api/checkin?secret=YOUR_CHECKIN_SECRET&latitude=<lat>&longitude=<lon>`.
4. Turn off "Ask Before Running" so it fires silently.

**Android (Tasker, or the free/simpler MacroDroid):**
1. Trigger: the built-in **Airplane Mode** state, or a **Location** context (geofence) — same
   two options as iOS.
2. Action: the built-in **HTTP Request** action, POSTing to the same URL as above.

Skip this section entirely if you don't want it — nothing else depends on it.

### 5. Anthropic API key (required for the assistant)
Get a key at [console.anthropic.com](https://console.anthropic.com/) and put it in
`server/.env` as `ANTHROPIC_API_KEY`.

### 6. Environment files

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
   local folders you want searchable, and optionally turn on the morning briefing / news,
   proactive WhatsApp push, and real-time alerts.
3. **Search** → one bar that searches mail, files, Teams chats, and saved WhatsApp documents
   at once, instead of searching each page separately.
4. **Assistant** → ask things like:
   - *"summarize my unread emails"* / *"archive everything from Nike"*
   - *"what's my week look like?"* / *"move my 3pm to Thursday"* / *"block out an hour tomorrow for X"*
   - *"find the latest invoice from X"* / *"anything new in Teams?"*
   - *"email Sarah about the meeting"* (it looks up her address for you first)
   - *"remember that the Acme account is my priority business"*
   - *"when did I fly to Berlin"* / *"what's the code on my license"* (after sending the relevant photo/document via WhatsApp)
   - *"how many Schengen days have I used in the last 180 days"* / *"how many days was I in France this year"* (needs location check-ins logged — see the setup section below)
5. **WhatsApp** (if configured) → message your test number directly — same assistant, same tools. Send a photo or PDF (boarding pass, license, ticket, receipt) and it gets analyzed and saved automatically.

## Known limitations

- **The morning briefing regenerates once per day** — on demand the first time you open the
  Assistant page that day (use Refresh to force it sooner), or automatically at a set time if
  you enable proactive push on the Setup page. Either way it only happens while the server
  process is actually running — see "Everything proactive needs the server running" below.
- **Everything proactive needs the server running** — the proactive briefing, Schengen alerts,
  and real-time email alerts are all driven by an in-process interval (`scheduler.ts`), not a
  true background cron job. If your laptop is asleep or the server isn't started, nothing
  fires; it catches up once the server is running again, but there's no guarantee of exact
  timing. This is the main reason to eventually move to an always-on deployment.
- **Real-time alerts poll, they don't push** — checked every ~5 minutes, capped at 5 individual
  alerts per check (a burst beyond that gets one summary message instead of a flood), and only
  for unread mail whose sender doesn't look automated. It's the same heuristic as "needs
  attention," just without the 3-day wait.
- **Google OAuth tokens can silently expire while the app is in "Testing" status** — Google
  invalidates refresh tokens after 7 days of the app sitting unverified/unpublished, regardless
  of use. Moving the OAuth consent screen to "In production" avoids this, though Google may
  require a verification step first since Gmail scopes are "sensitive." (The *symptom* — this
  used to look like silent empty results everywhere — is now caught and surfaced, see below.)
- **Broken connections are now detected** — every hub call that fails with what looks like an
  auth error (401/403, `invalid_grant`, expired/revoked token, etc. — checked across both
  Google's and Microsoft's very different error shapes) marks that specific account as needing
  reconnection. The Setup page shows a "Needs reconnecting" notice with a direct Reconnect link
  on the affected account, instead of every page just quietly showing no results. It's a
  heuristic on error shape, not a guarantee — an unrelated transient error (e.g. a brief
  network blip) could in theory trip it too, though a genuine auth failure is far more common
  in practice. The flag clears automatically the moment a call succeeds again, or when you
  reconnect.
- **Unified search inherits each source's own limitations** — if a Google/Microsoft connection
  is broken (now flagged, see above) or a source has no results, that section of Search just
  comes back empty.
- **"Needs attention" is a heuristic** — unread, older than 3 days, sender doesn't look
  automated. It's not true thread analysis, so it can miss or over-flag things.
- **Contacts search differs by provider** — Google only searches contacts you've explicitly
  saved; Microsoft's `/me/people` also surfaces people you've simply emailed before.
- **The "new scopes" banner doesn't auto-detect granted scopes** — it just shows whenever any
  account is connected and none of them are currently broken. Reconnecting again after you've
  already done so is harmless. (Separately, a genuinely broken/expired connection *is* now
  detected precisely — see "Broken connections are now detected" below.)
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
- **Document extraction is one-shot, at upload time** — a photo/PDF is analyzed once when it
  arrives and that text is what the assistant searches later; there's no re-analysis if the
  first pass missed something. Only images (jpeg/png/gif/webp) and PDFs are analyzed — other
  file types (e.g. Word docs) are stored for download but skipped for extraction.
- **Reverse geocoding uses OpenStreetMap's free Nominatim API** — no API key needed, but it's
  a shared public service with a fair-use rate limit; fine for personal check-ins (a handful a
  day), not for anything high-frequency.
- **No delete UI for check-ins yet** — the Setup page lists them read-only; removing a bad
  entry currently means editing the SQLite database directly.
- **Day-counting is check-in-based, not continuous tracking** — it reconstructs which country
  you were in each day from the gaps between check-ins (whichever check-in came most recently
  before that day), so accuracy depends on actually checking in at each border crossing (or
  sending a document that produces one). Days before your first-ever check-in aren't
  attributed to any country. The Schengen/EU country lists are also a reasonable
  approximation, not a legally authoritative source (e.g. Bulgaria/Romania's partial 2024
  Schengen accession is simplified to "in").
- **A boarding pass only gives one leg's day-math if it doesn't show separate times** — if a
  document shows just one timestamp for both departure and arrival (common — many boarding
  passes only print a single "Depart" time, no distinct arrival time), the two check-ins land
  on the same calendar day and the arrival leg wins for that day, so a same-day round trip can
  net to zero days credited to the departure country. Verified against a real boarding pass
  during testing — this is expected given the source data, not a bug, but worth knowing.

## Adding a new source later

Add a provider module in `server/src/providers/` (OAuth + list/search functions), route it
in `server/src/services/hub.ts`, and register its card in `/api/providers` (skip this last
step for non-account sources like local files). The inbox, chats, calendar, files, and
assistant tools pick it up automatically.

