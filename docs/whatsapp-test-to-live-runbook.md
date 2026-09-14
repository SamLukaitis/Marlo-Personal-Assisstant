# WhatsApp: going from Meta's test number to a live business number

Written 2026-09-14, the day Marlowe moved from Meta's free test number to the verified
business number `+44 7552 639982`. Part 1 is the incident write-up; Part 2 is the reusable
step-by-step for doing this again on any project; Part 3 is what it would take to move the whole
thing to a different company.

Concepts you need to hold in your head (Meta's UI hides most of this):

| Thing | What it is | Where the ID lives |
|---|---|---|
| **Meta App** | The developer app (`ASM_Assistant`). Owns the **webhook URL** and the **App Secret**. | App Dashboard → Settings → Basic |
| **Business Manager / Portfolio** | The company (Posidonia). Owns WABAs, System Users, and gets business-verified. | business.facebook.com → Business settings |
| **WABA** (WhatsApp Business Account) | A container inside the Business Manager that holds phone numbers **and message templates**. A project can have several (the test one, the live one). | WhatsApp → API Setup → "WhatsApp Business Account ID", or Business settings → Accounts → WhatsApp accounts |
| **Phone number** | Lives in exactly one WABA. Has its own **Phone Number ID** (what `WHATSAPP_PHONE_NUMBER_ID` holds). | WhatsApp → API Setup → "Phone number ID" |
| **System User token** | A permanent access token issued to a machine user of the Business Manager (`WHATSAPP_TOKEN`). | Business settings → Users → System users |

The relationship that caused today's outage: **a WABA only delivers webhooks to an app it is
explicitly subscribed to.** The webhook URL is configured once on the app, but each WABA must be
subscribed to the app separately. Meta does that automatically for the test WABA it creates in
your dashboard, and does **not** do it for a WABA created through business verification.

## Two things Meta never explains properly

### What a "message template" is, and why Marlowe needs two

WhatsApp has two kinds of business message:

- **Replies inside the 24-hour window.** Once a person messages your number, you can send them
  anything you like (free text, buttons, files) for 24 hours after their *last* message. Every
  ordinary Marlowe reply is this kind. No template involved.
- **Business-initiated messages.** Anything you send when that window is closed, e.g. the
  7 a.m. briefing to someone who last messaged you yesterday afternoon, or an important-email
  alert at lunchtime. Meta only allows these if the message is a **template**: a fixed piece of
  text you wrote in advance, submitted to Meta, and had approved. You fill in the variable part
  at send time; the surrounding wording cannot change. This is Meta's anti-spam rule, and it
  is why WhatsApp marketing spam is rarer than SMS spam.

Marlowe has exactly two, both category *Utility* (transactional, not marketing):

| Template | Fixed text | Variable | Used for |
|---|---|---|---|
| `marlowe_alert` | "Update from Marlowe: … Reply to this chat with any questions." | `update_text` | Important-email pings, Schengen warnings, reminders, any short one-off push |
| `marlowe_digest` | "Your Marlowe briefing: … Tap below to see the full details." + an **Open Marlowe** button | `briefing_text` | The scheduled daily briefing |

`server/src/services/outbound.ts` decides per message: if the person wrote in the last 24
hours, send free text; otherwise send the template with the same content squeezed into the
variable. Templates belong to a **WABA**, so a new WABA means resubmitting them. Approval is
automatic-ish and takes minutes to a day. Rejections are usually because Meta thinks the
wording is promotional (then it reclassifies to Marketing, which costs more per message).

### How many people can message the number now?

The "5 recipients" cap was a property of Meta's **test number** only. It is gone. With the
live number:

- **Inbound is unlimited.** Anyone in the world can message the number, and Marlowe can reply
  to all of them freely inside each person's 24-hour window. Adding users to Marlowe is
  now purely an invite in the app, no Meta step.
- **Outbound business-initiated messages are capped by a "messaging limit tier".** This is
  the number of *distinct people* you can start a template conversation with in a rolling
  24-hour period. The number is currently on **TIER_250** (250 people per day). Meta raises it
  automatically to 1,000, 10,000, 100,000 and then unlimited as you send more volume with a
  good quality rating (ours is GREEN). Being business-verified, which we now are, is a
  prerequisite for going past 250. A daily briefing counts as one conversation per user per
  day, so 250 is enough for 250 users' briefings.
- **App in Development mode** (if it still is): only people with a role on the Meta app can
  message it. Switch to Live mode (Part 2, step 10) before inviting anyone else.

## Part 1 — What happened on 2026-09-14

### Symptom

- Messaging the old **test** number → a reply arrived, but **from the business number**.
- Messaging the **business** number → no reply at all.

### What was actually going on

1. Railway's env had already been switched to the new Phone Number ID and a new permanent
   token, so every *outbound* send went out from the business number. Sending worked.
2. The old test WABA was still subscribed to the app. Messages to the test number reached the
   webhook, the server looked up the sender, and replied via whatever number was configured:
   the business number. Hence the cross-talk.
3. The new WABA had **no apps subscribed** (`GET /{WABA_ID}/subscribed_apps` returned an empty
   list). Meta never called the webhook for messages to the business number, so the server
   never saw them. Nothing in the server code was dropping anything.
4. Separately, the two message templates (`marlowe_alert`, `marlowe_digest`) did not exist on
   the new WABA. Templates belong to a WABA, so approvals on the test WABA don't carry over.
   Every proactive push outside a 24-hour window was failing with Meta error 132001.

### How we diagnosed it (so you can repeat it)

- Railway **HTTP logs** filtered to `webhooks`: showed POSTs from Meta only at the times the
  test number was messaged, none when the business number was.
- Railway **deploy logs** filtered to `whatsapp`: showed the trail of Meta error codes
  (see the table in Part 2) and typing-indicator errors saying the inbound message ID "does not
  exist", which means the inbound came through a different phone number than the one configured.
- Meta Graph API with the token from `server/.env` (now scripted as `npm run whatsapp:check`):
  token valid, phone number CONNECTED, app webhook correct, WABA not subscribed.

### The fix

```
cd server
npm run whatsapp:check -- 1574262347469069 --subscribe
```

That issues `POST /{WABA_ID}/subscribed_apps`. Within a minute, Meta was POSTing to
`/webhooks/whatsapp` for the business number and replies came back. Then both templates were
recreated on the new WABA via the API (status PENDING until Meta approves them).

## Part 2 — Step-by-step: test number → live number, on any project

Do these in order. Steps 1–3 involve waiting on Meta; start them first.

1. **Business verification.** Business settings → Security centre → Start verification. Legal
   name, address, and a document (Companies House extract, utility bill) that match exactly.
   Takes hours to a couple of weeks. Without it the number stays on the 250-conversation tier
   and cannot get an official display name review.
2. **Get a phone number that is free.** It must not be registered on the normal WhatsApp or
   WhatsApp Business app. If it is, delete that account in the app first (Settings → Account →
   Delete my account), then wait a few minutes.
3. **Add the number in the correct place.** Use App Dashboard → WhatsApp → API Setup → "Add
   phone number" while the *live* WABA is selected in the dropdown. Adding it from Business
   settings instead also works, but then you must do step 7 by hand. Verify the number by SMS or
   voice call.
4. **Register the number with the Cloud API.** In API Setup the number should show
   "Connected". If the server logs Meta error **133010** ("account is not registered"), set a
   two-step verification PIN on the number (WhatsApp Manager → Phone numbers → Settings →
   Two-step verification) and register it via API Setup → Register, or:
   `POST /{PHONE_NUMBER_ID}/register` with `{"messaging_product":"whatsapp","pin":"<6 digits>"}`.
5. **Create a System User and a permanent token.** Business settings → Users → System users →
   Add (role Admin) → Assign assets: the WhatsApp account (Full control) **and** the Meta app
   (Develop app). Then Generate token, choose the app, tick `whatsapp_business_messaging`,
   `whatsapp_business_management`, `business_management`, expiry **Never**. Save it in a
   password manager. This replaces the 24-hour temporary token from API Setup.
6. **App webhook (app-level, only once per app).** App Dashboard → WhatsApp → Configuration →
   Webhook: Callback URL `https://<your host>/webhooks/whatsapp`, Verify token = the value of
   `WHATSAPP_VERIFY_TOKEN`, then subscribe to the **messages** field. If this was already done
   for the test number, nothing changes here.
7. **Subscribe the live WABA to the app.** The step Meta's UI has no button for.
   `npm run whatsapp:check -- <WABA_ID> --subscribe`, or by hand:
   ```
   curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <SYSTEM_USER_TOKEN>"
   ```
   Confirm with a GET to the same URL: your app should be listed.
8. **Update the server's environment.** `WHATSAPP_PHONE_NUMBER_ID` = the live number's Phone
   Number ID, `WHATSAPP_TOKEN` = the System User token. `WHATSAPP_APP_SECRET` and
   `WHATSAPP_VERIFY_TOKEN` stay the same because they belong to the app, not the number. Set
   them in **both** Railway (Variables tab, then redeploy) and `server/.env`.
9. **Recreate message templates on the live WABA.** Every template the code sends must exist
   and be APPROVED on the WABA the live number belongs to. For Marlowe that is
   `marlowe_alert` and `marlowe_digest`, both `en_US`, category Utility, with **named**
   parameters (`update_text`, `briefing_text`). The exact bodies are in the comment above
   `sendWhatsAppTemplate` in `server/src/providers/whatsapp.ts`. Approval usually takes minutes
   to a day. Until then only replies inside a 24-hour window go out.
10. **Switch the app to Live mode.** App Dashboard → top bar toggle. Needs a Privacy Policy URL
    and Terms URL in Settings → Basic (this repo serves `/privacy` and `/terms`). In
    Development mode only people with a role on the app can message the live number.
11. **Retire the test number.** Once the live number works, delete the test number from API
    Setup or unsubscribe the test WABA from the app, so test-number messages stop leaking into
    production and replying from the wrong number.
12. **Verify end to end.** Run `npm run whatsapp:check -- <WABA_ID>` (all ticks), send a message
    to the live number, and confirm a `POST /webhooks/whatsapp` in Railway's HTTP logs plus no
    `whatsapp:` errors in the deploy logs.
13. **Tell your users.** They must save and message the new number. Their Marlowe registration
    does not change (it is keyed on *their* phone number), but the 24-hour service window
    restarts from their first message to the new number.

### Meta error codes seen during this migration, and what each one means

| Code / text | Meaning | Fix |
|---|---|---|
| `100` GraphMethodException "Unsupported request - method type: post" | `WHATSAPP_PHONE_NUMBER_ID` is not a phone-number object, or the token cannot see it | Check the ID; assign the WABA to the System User |
| `133010` "The account is not registered" | Number not registered with Cloud API | Step 4 |
| `132001` "Template name does not exist in the translation" | Template missing on *this* WABA | Step 9 |
| `131047` | 24-hour customer-service window closed | Expected; the code falls back to a template |
| Typing indicator "Message ID ... does not exist" | Inbound came via a different phone number than the one configured | Old WABA still subscribed, or env points at the wrong number |
| No `POST /webhooks/whatsapp` in HTTP logs at all | Meta never called us | WABA not subscribed (step 7), wrong callback URL, or app in Development mode |
| "signature verification failed" in deploy logs | `WHATSAPP_APP_SECRET` wrong or regenerated | Copy App Secret from Settings → Basic |

### Where each value comes from

| Env var | Belongs to | Where to find it | Changes when... |
|---|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Phone number | WhatsApp → API Setup | You change number |
| `WHATSAPP_TOKEN` | System User (Business Manager) | Business settings → System users → Generate token | You rotate it or change Business Manager |
| `WHATSAPP_APP_SECRET` | Meta app | Settings → Basic → App Secret | You reset it or change app |
| `WHATSAPP_VERIFY_TOKEN` | You (made up) | `server/.env` and Webhook config | Never, unless you choose to |
| WABA ID (not an env var) | Business Manager | API Setup / Business settings → WhatsApp accounts | You change WABA |

## Part 3 — Moving the project from Posidonia to another company

Short version: **moderate effort, mostly waiting on Meta, and the WhatsApp number is the awkward
part.** Everything else is a few hours. Do it while there are few users; it only gets harder.

What is tied to Posidonia today and how each piece moves:

| Asset | Owned by | How it moves | Pain |
|---|---|---|---|
| **WABA + phone number** | Posidonia's Business Manager | A number lives in exactly one WABA and WABAs are not transferable between Business Managers by users. Practical path: the new company gets business-verified, creates its own WABA, then the number is **deleted from Posidonia's WABA and re-added** to the new one (brief downtime, new Phone Number ID, quality rating and messaging tier reset, display name re-reviewed). Templates recreated and re-approved. | High. Business verification for the new company is days to weeks; plan the switch for a quiet day. |
| **Meta App (`ASM_Assistant`)** | Whoever's developer account/Business Manager it is attached to | Meta allows changing an app's associated business in App Dashboard → Settings → Basic (check the current docs; the exact path moves around). If that fails, creating a new app takes about 30 minutes: new App ID and App Secret, re-enter the webhook, re-subscribe the WABA, new System User token. | Low to medium. |
| **System User token** | Business Manager | Must be regenerated under the new company's Business Manager. | Low. |
| **Google Cloud project** (OAuth client, consent screen) | Whichever Google account created it | Keep the *same* project and OAuth client if at all possible: every user's Google refresh token is bound to that client ID, so a new client means every user reconnects Gmail. Projects can be moved into another organisation's Google Cloud account, or ownership shared. | Low if kept, medium if recreated. |
| **Azure app registration** | Whichever Microsoft tenant created it | Same story as Google: keep it, or every Outlook user reconnects. | Low if kept. |
| **Railway project** | Sam's workspace | Railway supports transferring a project to another workspace; the volume (SQLite + uploads) and variables go with it. | Low. |
| **Domain** | Railway-generated `marlowe.up.railway.app` | Get a custom domain owned by the new company before migrating. The URL is baked into OAuth redirect URIs, the webhook callback, the `marlowe_digest` template button, and `SERVER_URL`. Changing it later touches all of those. | Medium, only because it fans out. |
| **Anthropic API key** | Whoever's console account | New key under the new company's account, swap the env var. | Trivial. |
| **Legal pages** | Hardcoded | `/privacy` and `/terms` in `server/src/index.ts` name "Posidonia Environmental Services Ltd"; the contact email is already an env var (`PRIVACY_CONTACT_EMAIL`). Parameterise the company name the same way. | Trivial. |
| **Encryption key + data** | Railway volume + env | Moves with the Railway project. Back up `ENCRYPTION_KEY` before touching anything. | Trivial, high stakes. |

Recommended order when the time comes:

1. New company: Meta Business Manager, business verification, custom domain, Anthropic account.
2. Transfer the Railway project; add the custom domain; update `SERVER_URL`, `CLIENT_URL`,
   Google and Microsoft redirect URIs, and the webhook callback URL. Users notice nothing.
3. New company's WABA: System User, token, subscribe to the app, templates submitted for
   approval *before* the number moves.
4. On a quiet day: delete the number from Posidonia's WABA, add it to the new WABA, register,
   update `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN`, redeploy, run `npm run whatsapp:check`.
5. Parameterise the company name in the legal pages and retire Posidonia's Meta assets.
