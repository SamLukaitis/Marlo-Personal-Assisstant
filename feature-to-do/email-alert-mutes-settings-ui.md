# Show email alert mutes in Settings

Mutes ("stop telling me about Railway crash emails") can only be added, listed and removed in chat,
through the `mute_email_alerts` tool. Settings should show them with a remove button, next to the
existing people/important alert toggles (`server/src/routes/alertRoutes.ts`). The data is the
`email_alert_mutes` setting; helpers are in `server/src/services/emailAlertSettings.ts`.
