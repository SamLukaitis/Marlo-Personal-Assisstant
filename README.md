# Marlowe — Personal Assistant Hub

Marlowe is a private, invite-only personal assistant that brings email, calendars, files, chats, travel information, and personal notes into one web application. It combines a React/Vite client with an Express/TypeScript API and Anthropic Claude tool-calling.

Marlowe can be used from the web app and, optionally, through WhatsApp. It is designed for a small, trusted group of users rather than public self-service signup.

## What Marlowe does

- **AI assistant:** Ask Claude questions about connected accounts and personal data. The assistant can search sources, summarize information, manage personal calendar events, create email drafts, maintain memory notes, and use other application tools.
- **Google integration:** Gmail, Google Calendar, Google Drive, and Google Contacts through OAuth.
- **Microsoft integration:** Outlook mail, Microsoft Calendar, OneDrive, Teams chats, and Microsoft contacts through OAuth.
- **Multiple accounts:** Connect multiple Google and Microsoft accounts and search across them from one hub.
- **Unified search:** Search email, cloud files, local files, chats, and saved documents in one place.
- **Local files:** Configure folders such as Documents or Desktop for local filename search; no OAuth connection is required.
- **WhatsApp channel:** Message Marlowe through Meta's official WhatsApp Cloud API. Incoming messages are routed to the correct user by their registered phone number.
- **Document capture:** Send supported images, PDFs, or Word documents through WhatsApp for extraction and later search.
- **Briefings and reminders:** Generate daily briefings and schedule proactive WhatsApp notifications while the server is running. Unprompted messages go through one gate (`server/src/services/attention.ts`): only urgent things interrupt (max 4 a day, quiet hours 22:00–07:00), bookings, renewals and bills become reminders at the right moment, and the rest is acknowledged in the briefing or evening recap.
- **Travel tools:** Record location check-ins, inspect travel history, and calculate country/Schengen/EU day counts from the check-in timeline.
- **News, weather, and markets:** Optional external information providers are available through the assistant and briefing features.
- **Places and travel times (optional):** With `GOOGLE_MAPS_API_KEY` set, the assistant finds real nearby places and driving/walking times through Google's Maps Grounding Lite MCP server. On WhatsApp it can ask for your location with a one-tap "Send location" button.
- **Administration:** Admin users have access to a separate portal for operational tools, logs, user administration, and application health information.

## Safety and privacy boundaries

- Access is **invite-only**. An administrator must invite an email address before that person can use the application.
- Each user's connected accounts, documents, settings, memories, phone numbers, and conversations are isolated by tenant-aware API routes.
- Marlowe never sends email on its own: every email it writes is shown to the user first and only sent after they explicitly tap Send (otherwise it's saved to their Drafts).
- Calendar actions are limited to the user's own calendar; it does not invite other people to events.
- Archiving email is non-destructive; messages are not deleted by the assistant.
- WhatsApp webhooks use Meta verification/signature checks, and only registered phone numbers are routed to a user's assistant.
- OAuth tokens and uploaded documents are encrypted at rest with AES-256-GCM. Keep `ENCRYPTION_KEY` backed up separately: losing it makes encrypted data unrecoverable.
- Location history, extracted document text, and WhatsApp conversation history are currently stored as application data and should be treated as sensitive.

## Architecture

```text
client/   React 19 + TypeScript + Vite frontend
server/   Express + TypeScript API, OAuth providers, Claude tools, SQLite persistence
```

The server exposes the API and, after a production build, serves the compiled client from `client/dist`. The application uses SQLite for local persistence and an in-process scheduler for proactive features.

Important server areas include:

- `server/src/ai/` — Claude assistant and tool definitions
- `server/src/providers/` — Google, Microsoft, WhatsApp, local files, news, weather, and markets
- `server/src/routes/` — authentication, account, assistant, search, documents, travel, admin, portal, and webhook APIs
- `server/src/services/` — hub aggregation, briefings, alerts, reminders, documents, travel calculations, scheduling, and encryption
- `server/src/db/` — SQLite access and migrations
- `client/src/pages/` — assistant, calendar, chats, files, travel, settings, onboarding, and admin portal screens

## Requirements

- Node.js with npm
- A Google OAuth application for Google features
- A Microsoft Entra/Azure OAuth application for Microsoft features (optional)
- An Anthropic API key for the assistant
- A Meta WhatsApp Cloud API application for WhatsApp (optional)

## Local development

### 1. Configure environment files

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

At minimum, set `ANTHROPIC_API_KEY` in `server/.env`. For Google sign-in and account connections, configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI=http://localhost:4000/auth/google/callback`

The Microsoft, WhatsApp, travel check-in, encryption, and provider settings are optional. See the comments in `server/.env.example` for the complete list and setup notes.

Generate an encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the resulting 64-character hexadecimal value in `ENCRYPTION_KEY`.

### 2. Install dependencies and start the app

Run the API and client in separate terminals:

```bash
# Terminal 1
cd server
npm install
npm run dev
```

```bash
# Terminal 2
cd client
npm install
npm run dev
```

Open <http://localhost:5173>. The client expects the API at `http://localhost:4000` by default; change `VITE_API_BASE` in `client/.env` if needed.

Because access is invite-only, invite a user from the server directory before they sign in:

```bash
cd server
npm run invite -- someone@example.com
```

## Production build and start

The root scripts install and build both workspaces, then start the compiled server:

```bash
npm run build
npm start
```

The server listens on `PORT` (4000 by default). Set `CLIENT_URL`, `SERVER_URL`, and `NODE_ENV=production` for a deployed environment. The production server serves the built frontend and includes a `/health` endpoint for health checks.

Proactive briefings, alerts, and reminders run in-process. The server must remain running for those features to fire, so an always-on deployment is recommended.

## Useful commands

### Server

```bash
npm run dev              # Start the API with TypeScript watch mode
npm run build            # Compile TypeScript to dist/
npm start                # Run the compiled API
npm test                 # Run the Vitest suite
npm run eval:grounding   # Run assistant grounding evaluations
npm run invite -- EMAIL  # Invite a user
npm run whatsapp:check -- <WABA_ID> --subscribe
```

### Client

```bash
npm run dev      # Start Vite development server
npm run build    # Type-check and build the frontend
npm run lint     # Run Oxlint
npm run preview  # Preview the production build
```

## OAuth redirect URLs

For local development, register these callback URLs with the relevant providers:

```text
Google:    http://localhost:4000/auth/google/callback
Microsoft: http://localhost:4000/auth/microsoft/callback
```

WhatsApp requires a publicly reachable HTTPS webhook. Configure Meta to call:

```text
https://<your-server>/webhooks/whatsapp
```

The exact WhatsApp setup, phone allowlisting, location automation examples, encryption notes, and deployment limitations are documented in `server/.env.example` and the repository's `docs/` directory.

## Repository contents

- `client/` — React/Vite frontend
- `server/` — Express/TypeScript backend
- `docs/` — operational and integration documentation
- `changelog/` — project change history
- `feature-to-do/` — feature backlog

## Current limitations

- The application is private and invite-only; it is not currently packaged as a public SaaS.
- Proactive jobs depend on the server process and its in-process schedulers.
- Email alerts are polling-based rather than provider push notifications.
- Travel day calculations depend on the accuracy and frequency of location check-ins and are not legal advice.
- WhatsApp is a new assistant channel; it does not read a user's existing personal WhatsApp conversations.
- Provider availability and search results depend on the permissions and connection health of each account.
