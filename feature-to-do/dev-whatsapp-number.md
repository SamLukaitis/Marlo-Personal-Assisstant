# Separate WhatsApp number/app for local development

Right now there's only one Meta app/number, and its webhook can only point at one URL at a time —
so testing a local change via WhatsApp means temporarily repointing the webhook at an ngrok
tunnel, which makes production WhatsApp (Sam, Dad) go quiet until it's switched back. A dedicated
dev-only WhatsApp Business number would let local testing happen without ever touching what
production is pointed at. Not urgent with just 3 users, but will matter more as this grows.
