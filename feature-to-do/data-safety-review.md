# Data safety review — where we stand and what's next

Written 2026-10-04 from a read through the code and project docs, for Jake and Sam to work through
later. This is not a professional penetration test.

**Short version:** good enough for a small invite-only beta, not yet for a public launch. The gaps
are mostly operational habits, paperwork and a few missing features, not fundamental design flaws.

---

## 1. What protects user data today

**Who can get in**
- Invite-only: nobody can use Marlowe unless an admin has invited their email or phone number.
- Login is Google/Microsoft OAuth, so there is no password database to steal.
- Session tokens are stored only as hashes, so a stolen database contains no working logins.
  The cookie is `httpOnly`, `Secure` in production, `SameSite=Lax`, and has a 30-day sliding expiry.
- Microsoft users are identified by tenant id + object id, not by the editable `mail` field (fixed
  in the 2026-09-15 review; this blocks the "nOAuth" takeover trick).

**Keeping users apart**
- Marlowe: one shared SQLite database, with every query scoped by `owner_id`. This is a rule each
  feature has to follow, not something the database enforces (see `tenant-isolation-audit.md`).
- Joyce is stronger: one database file per family, plus a per-family encryption key. Even with a
  bug, one family can't read another's data.

**Encryption**
- In transit: HTTPS/TLS everywhere (browser, Google, Microsoft, Anthropic, Meta).
- At rest, encrypted with AES-256-GCM (`server/src/services/crypto.ts`): Google/Microsoft OAuth
  tokens and uploaded document files.
- At rest, **not** encrypted: WhatsApp chat history, memory notes/facts, location check-ins,
  conversation summaries, text extracted from documents, and error logs.

**Limits on what the assistant can do**
- Irreversible tools (`send_email`, `delete_calendar_event`, `unsubscribe_from_sender`,
  `undo_expense`) can run only after the user taps a confirm button. This is enforced in code
  (`CONFIRM_REQUIRED_TOOLS`, `server/src/ai/assistant.ts`), not just requested in the prompt.
- Calendar events never invite anyone, archiving never deletes, there is no general web-fetch
  tool, and web search is capped at 5 per message.
- The user id always comes from the server, never from the model, so a tricked assistant can only
  reach the victim's own data.
- WhatsApp webhooks are verified with Meta's signature, and only registered phone numbers are
  routed to an account.
- Forwarded-link fetching blocks private and internal network addresses (SSRF guard).
- All 12 issues from `docs/code-review-2026-09-15.md` are fixed.

---

## 2. How a breach could happen (most to least likely)

1. **Someone gets into the Railway account.** The database and `ENCRYPTION_KEY` sit side by side
   there, so the encryption wouldn't help. This is the biggest single risk.
2. **Someone takes over an admin's Google account.** Admins sign in with Google and can read any
   user's WhatsApp history in the conversation viewer (`/api/admin/messages`).
3. **A bug lets one user see another's data** (a query that forgets the `owner_id` filter).
4. **Leaked secrets.** The Anthropic key was once pasted into a chat. Permanent tokens also sit in
   `.env` files on laptops.
5. **Prompt injection.** A booby-trapped email or link steers the assistant (see section 6).
6. **A breach at a supplier:** Anthropic, Meta, Google, Microsoft or Railway.
7. **Error logs** can capture user content. They are stored in the database (Portal Logs tab) and
   in Railway's logs.

---

## 3. Next steps checklist

**This week (cheap, high impact)**
- [ ] 2FA on Railway, GitHub, Meta Business, Google Cloud, Azure, Anthropic, and both founders'
      Google accounts (passkey or hardware key if possible).
- [ ] Rotate the Anthropic API key that was exposed in chat.
- [ ] Save `ENCRYPTION_KEY` and `JOYCE_MASTER_KEY` in a password manager. Losing either one makes
      encrypted data permanently unreadable. Also ask Sam whether a copy is on his laptop.
- [ ] Set up database backups. Right now there is one copy on one Railway volume.

**Before a public launch (engineering)**
- [ ] Encrypt the remaining sensitive fields, ideally with per-user keys (section 7).
- [ ] Move the master key into a KMS (section 8).
- [ ] Self-serve "download my data" and "delete my account". `deleteUserCompletely` exists, but
      only an admin can trigger it today.
- [ ] Automated tenant-isolation check on every change (`tenant-isolation-audit.md`).
- [ ] Restrict admin access to user conversations, and log every admin view.
- [ ] Scrub personal content from error logs, and delete old logs automatically.
- [ ] Prompt-injection hardening (section 6).
- [ ] An independent penetration test.

---

## 4. Is it safe enough to launch?

- **Closed beta with people who know they're testers: yes.**
- **Public product: not yet.** The two hard blockers:
  - Google caps unverified apps at 100 users and shows an "unverified app" screen until the app
    passes Google's security review (CASA).
  - The UK GDPR basics aren't in place yet (section 5).

---

## 5. What's needed to go to market (data safety only)

Posidonia is a UK company, so UK GDPR applies; EU GDPR applies too if we serve EU users.

**Legally required**
- [ ] Register with the ICO and pay the data protection fee (about £40–£60 a year).
- [ ] Rewrite the privacy policy (`/privacy` in `server/src/index.ts`). It currently says Marlowe
      is invite-only and not public. It needs to cover what data we hold and why (legal basis),
      how long we keep it, who we share it with, users' rights, and how to complain to the ICO.
- [ ] Data processing agreements with each supplier: Anthropic, Meta, Google, Microsoft, Railway.
      Ask Anthropic about zero data retention.
- [ ] International transfer cover for US suppliers (UK–US data bridge, or the IDTA). Check which
      region Railway hosts us in.
- [ ] A Data Protection Impact Assessment (DPIA). It's effectively mandatory, because an AI reading
      email, location and documents counts as high-risk processing.
- [ ] A breach response plan: serious breaches must be reported to the ICO within 72 hours.
- [ ] A way to honour access and deletion requests within one month.
- [ ] Joyce: the ICO Children's Code applies if children's data is involved, and families may
      share sensitive details such as health information.

**Platform requirements**
- [ ] Google OAuth verification plus the yearly CASA security assessment, because the Gmail and
      Drive permissions we request are "restricted". This is the biggest single launch gate.
- [ ] Microsoft Publisher Verification.
- [ ] Meta/WhatsApp: already business-verified; keep the privacy policy and terms accurate.

**Optional**
- Cyber Essentials (UK): a few hundred pounds, takes weeks, and is a good trust signal.
- SOC 2 (a US audit standard, not an ISO): only needed if business customers ask for it.

**Relevant ISO standards** (none are legally required; they're what business customers and
investors recognise). "Certifiable" means an accredited auditor can certify us against it; the
others are guidance that the auditor uses alongside.

| Standard | What it covers | Certifiable? | Relevance to us |
|---|---|---|---|
| **ISO/IEC 27001** | An information security management system: risk assessment, policies, access control, incident response, continuous improvement | Yes | 🚩 **The main one.** The usual first certification for selling to businesses. Typically £10k–£30k+ and 6–12 months the first time, plus yearly audits |
| **ISO/IEC 27701** | A privacy extension to 27001, mapped to GDPR: handling personal data, user rights, processors | Yes, on top of 27001 | 🚩 **High.** Marlowe's whole job is processing personal data, and this is the ISO way to show GDPR compliance |
| **ISO/IEC 42001** | An AI management system: AI risks, oversight, transparency, data used by AI | Yes | 🚩 **High, and growing.** Marlowe is an AI product; this answers "how do you control the AI?" (prompt injection, what it can do) and lines up with the EU AI Act |
| ISO/IEC 27002 | The detailed catalogue of security controls behind 27001 (encryption, key management, logging, supplier security) | No (guidance) | Medium: the practical how-to when building 27001 controls, including KMS and key handling |
| ISO/IEC 27017 | Security controls specific to cloud services | No (assessed with 27001) | Medium: we're a cloud service running on Railway, Anthropic and other suppliers |
| ISO/IEC 27018 | Protecting personal data in public cloud services | No (assessed with 27001) | Medium: the cloud-and-personal-data version, often asked for alongside 27001 |
| ISO/IEC 27035 | Incident management: detecting, responding to and learning from breaches | No (guidance) | Low–medium: useful template for the 72-hour breach plan above |

Suggested order, when business customers start asking: Cyber Essentials → ISO 27001 + 27701
together (one audit programme) → ISO 42001. For a consumer launch, none of these are needed
first; the legal and Google items above come first.

**Suggested route:** week-one fixes → a GDPR lawyer or consultant for the policy, DPIA and
contracts → Google CASA → public launch.

---

## 6. Prompt injection

Nobody has fully solved this. The aim is to limit the damage a fooled assistant can do, not to
make it impossible to fool. Real harm needs all three of the "lethal trifecta": the assistant can
see private data, it reads untrusted content, and it has a way to send data out. We can't remove
the first two without removing the product, so we control the third.

**Done (2026-10-04)**
- [x] The send-email confirmation now ends with a server-written "📧 Sending to: <address>" line,
      taken from the exact input the Send tap will run, so the AI's own wording can't hide the
      real recipient (`buildChoiceReply` in `server/src/ai/assistant.ts`).
- [x] After the Send tap, Marlowe checks the sending mailbox's Sent folder. If it holds no earlier
      email to that address, Marlowe asks "⚠️ Warning — you haven't emailed this person before.
      Are you sure x@y.com is the correct email?" and sends only on "Yes, send". If the Sent folder
      can't be checked, it warns anyway (`server/src/services/actionHandlers.ts`).

**Still open**
- [ ] Show the subject and body in the confirmation from the server too, not only the recipient.
- [ ] Memory poisoning: `remember` runs without confirmation, so an email could plant a fake fact
      ("my accountant is x@evil.com"). Record where each fact came from, and don't let facts that
      came from emails or documents decide recipients without showing them to the user.
- [ ] Links in replies: Marlowe could be tricked into writing a link that carries private data out
      when the user taps it. Remove links, or allow only known ones.
- [ ] Label email, document and web content as untrusted data in the main prompt (a weak but cheap
      defence).
- [ ] "Taint mode": once untrusted content has entered a turn, every action that sends anything
      outward needs confirmation for the rest of that turn.
- [ ] Long-term: the quarantined-reader design. A second model with no tools reads raw emails and
      returns only structured facts; the main assistant never sees the raw text (Google
      DeepMind's research version is called CaMeL).
- [ ] A library of attack test emails, run on every release (could plug into
      `server/src/eval/`).
- [ ] Archive, label and alert-setting changes don't need confirmation, so a tricked assistant
      could quietly hide an email (for example a security alert). Consider confirming these too.

---

## 7. Encryption and per-user keys

- Today one key (`ENCRYPTION_KEY`) encrypts everyone's tokens and documents. It's a Railway
  environment variable, on the same platform as the database.
- **What it protects against:** a leaked database file or backup on its own.
- **What it doesn't protect against:** someone inside the Railway account, or someone who takes
  over the running server.
- Plan: per-user keys, the same way Joyce works (`server/src/joyce/familyKey.ts`). Each user's key
  is derived (HKDF) from the master key plus a random per-user salt.
  - Benefit: a bug that fetches another user's rows can't decrypt them.
  - Benefit: crypto-shredding. Deleting a user's salt or key makes their data unreadable
    everywhere, including old backups, which is a strong answer to GDPR deletion requests.
  - Cost: the database can't search inside encrypted text. Memory, chat history and document
    search would decrypt a user's rows on the server and then search them. That's fine at our
    size, because each user's data is small.
  - Cost: existing data needs a one-off migration.
- The encryption itself is free (AES is a public standard built into Node) and runs on the Railway
  server's CPU, which has hardware AES support. Its cost is negligible next to the AI calls. The
  real cost is engineering time: roughly a week or two for the full version.

---

## 8. KMS (key management service)

**What it is.** A KMS is a cloud service that holds the master key inside tamper-resistant
hardware (an HSM). The key never leaves the KMS. Our server asks it to wrap or unwrap keys; every
use is permission-checked and logged; and access can be revoked instantly.

**How we'd use it (envelope encryption)**
- One master key lives in the KMS.
- Each user's data key is encrypted by that master key and stored in our database.
- On startup, or when needed, the server asks the KMS to unwrap a user's data key, then uses it in
  memory.

**What it improves**
- A stolen database plus stolen environment variables is no longer enough on its own: revoke the
  server's KMS credentials and the copy is useless.
- Every key use leaves an audit trail.
- **Honest limit:** the server's KMS credentials still live on Railway. Someone who takes over the
  live server can still ask the KMS to unwrap keys while they're inside. They can't take the
  master key away with them, though, and they get cut off once the credentials are revoked.

**Cost**
- AWS KMS: about $1 a month per master key, plus about $0.03 per 10,000 requests.
- Google Cloud KMS: about $0.06 a month per key version, plus about $0.03 per 10,000 operations.
- With one master key and data keys cached in memory, either one is a few dollars a month at our
  scale. Railway has no KMS of its own, so we'd call AWS or Google from the server.
- The real cost is engineering time: a few days, on top of the per-user-key work in section 7.
- Check current prices before deciding.

**How big companies stop insiders stealing keys**
- Keys are held in HSMs. Nobody, including the founders, can export the raw master key.
- Separation of duties: the people who run the servers aren't the people who can approve key
  access.
- Multi-party approval ("two-person rule"): sensitive access needs a second person to approve it,
  and is granted just in time and for a limited period.
- Tamper-evident audit logs, reviewed by an independent security team. Some providers also let
  customers see when staff access their data (for example Google's Access Transparency).
- Customer-held keys for the most sensitive customers (customer-managed or external keys, or
  client-side encryption). Without the customer's own key service, the provider literally can't
  decrypt the data.
- External audits (SOC 2, ISO 27001) check that all of the above is actually done.

**Is there a law about who can access keys?**
- No law says exactly who may hold encryption keys. The law sets outcomes, and companies choose
  the controls:
  - UK GDPR Art. 5(1)(f) and Art. 32 require "appropriate technical and organisational measures",
    with encryption named as an example.
  - Fines go up to £17.5m or 4% of global turnover, and breaches must be reported within 72 hours.
- Insiders are deterred by criminal law: s.170 of the Data Protection Act 2018 makes it an offence
  to knowingly obtain personal data without the company's consent, and the Computer Misuse Act
  1990 covers unauthorised access.
- Governments can compel access through legal process (for example the UK Investigatory Powers
  Act and the US CLOUD Act).
- So for most services, users rely on trust that is backed by audits, contracts, laws and
  reputation, not on mathematics. The only mathematical guarantee is end-to-end or client-side
  encryption, where only the user holds the key. That isn't possible for Marlowe, because the
  assistant has to read email on the server to work.
