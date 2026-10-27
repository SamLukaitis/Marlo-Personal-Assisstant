# The assistant is now called Marlo, not Marlowe

Everything people read now says "Marlo": the app pages, the WhatsApp message text, the assistant's
own name in its prompts, the README and the docs.

Only words changed. Names that other systems depend on were left alone on purpose, because
changing them would break live behaviour: the WhatsApp template names (`marlowe_alert`,
`marlowe_digest`, `marlowe_whats_new`, approved by Meta), the database column `marlowe_linked`,
env vars such as `MARLOWE_SHORTCUT_ICLOUD_URL`, the `X-Marlowe-Shortcut` header the iOS Shortcut
sends, the file `createMarloweTemplates.ts`, and the `marlowe.up.railway.app` host. Old changelog
entries and `docs/superpowers/` plans/specs are history and still say Marlowe.

Renaming those code-level names would need new Meta template approvals, a database migration, new
Railway env vars, a rebuilt Shortcut and a new domain, all in step with a deploy.
