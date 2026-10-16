Joyce, the family WhatsApp assistant, is back in the main app and live on her own number, +44 7337 916848.

Joyce was built on `staging` in early October but taken out of `master` on 2026-10-06 (two revert
commits) because her WhatsApp number didn't exist yet. Now that the number is set up, this change
puts both commits back unchanged: the original Joyce code, and photo/file saving.

To switch her on in production:
- the `JOYCE_*` variables were set in Railway (see `server/.env.example`)
- Joyce's number got a WhatsApp webhook override so Meta delivers her messages to
  `/webhooks/joyce` rather than Marlowe's `/webhooks/whatsapp` (Meta allows one webhook URL per
  app; the override applies to her number only)

Marlowe already ignores messages addressed to Joyce's number (changelog
`2026-10-16-marlowe-ignores-joyce-number.md`).

Known gaps, for whoever picks this up: anyone who messages Joyce can start a family (there's no
invite list), her Claude API spend isn't tracked, reminders are UTC-only and are only delivered
when the person next messages her. See `feature-to-do/joyce-family-assistant.md` → "Not built yet".
