Flight and hotel links in Marlowe's replies are now short `/go/` links, and Marlowe's chat replies follow a written style guide: professional, brief and formatted for WhatsApp.

## What changed

### Short links

Google Flights and Google Hotels URLs run to several hundred characters, and Kiwi.com and
Booking.com links aren't much shorter, so a flight or hotel reply on WhatsApp was mostly URL.

- `server/src/services/shortLinks.ts` stores a long URL under an 8-character code and hands back
  `<SERVER_URL>/go/<code>`. URLs of 60 characters or fewer (a hotel's own website, say) are left as
  they are, because they're already readable and show where they go.
- `search_flights` and `search_hotels` (`server/src/ai/assistant.ts`) pass their results through
  `shortenResultLinks` before the model sees them, so `googleFlightsUrl`, `googleHotelsUrl`,
  `bookingUrl` and `website` arrive already short. The model can only repeat the short form.
- `server/src/routes/shortLinkRoutes.ts` serves `GET /go/:code` publicly (links are tapped from
  WhatsApp with no session) and redirects to the stored URL. Only URLs Marlowe stored can be
  reached, so it isn't an open redirect. Links last 30 days; after that, or for an unknown code,
  the page says the link has expired and to ask Marlowe again.
- New `short_links` table in `server/src/db/store.ts`. Expired rows are pruned at most once an hour
  when a new link is made, and `deleteUserCompletely` removes a user's rows.
- The hotels rule now asks for the website of only the one or two hotels Marlowe recommends,
  rather than one link per hotel listed.

For a short link to be short, `SERVER_URL` has to be the public address (for example
`https://marlowe.up.railway.app`); on `localhost` the links only work on the same machine.

### Chat voice

The only instruction about tone used to be one line, "Keep answers concise and lead with the
direct answer", at the end of a long list of tool rules. It's now its own section,
`server/src/ai/chatVoice.ts`, sent with every message as part of the system prompt. It asks for:

- a professional, courteous, brief register, leading with the answer;
- one to three sentences for most replies, and lists only to compare options (five items at most);
- no filler ("Great question", "Happy to help"), no emoji, few exclamation marks, no
  "let me know if you need anything else";
- WhatsApp-safe formatting: no headings, tables or `[text](url)` links, single-asterisk bold, and
  each link on its own line after a short label.

A user's own "persona" setting still wins over these defaults. The morning briefing and evening
round-up keep their own, warmer voice in `server/src/services/proactiveVoice.ts`, and Joyce is
unchanged.

### Seeing which flight and hotel search is in use

If `SERPAPI_API_KEY` isn't set, the server now logs a warning at startup saying that flight search
is using Kiwi.com and hotel search is using lastminute.com. It appears in the Portal's Logs tab.
When the key is set but a SerpApi search fails (a wrong key, or the month's searches are used up),
the existing `search_flights: SerpApi lookup failed` / `search_hotels: SerpApi lookup failed`
warnings appear there with SerpApi's own error message.
