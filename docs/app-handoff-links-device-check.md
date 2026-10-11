# App hand-off links: device check

Send each link to yourself on WhatsApp and tap it on an **iPhone** and an **Android** phone, once with
the app installed and once without. Fill in the table. If an app opens but doesn't pre-fill, fix its
builder in `server/src/services/appLinks.ts` (plus its exact-URL test). If it can't be made to work,
remove the app from `APP_NAMES`, `BUILDERS`, its tests, the `make_app_link` tool description and the
prompt rule in `server/src/ai/assistant.ts`.

Regenerate fresh links (the dates must be in the future) from `server/`:

```bash
npx tsx -e "import('./src/services/appLinks.ts').then(({ makeAppLink }) => console.log(makeAppLink({ app: 'spotify', query: 'lofi beats' }, { today: new Date().toISOString().slice(0, 10) })))"
```

Sample links generated on 2026-10-12:

| App | Link | iOS app | iOS web | Android app | Android web |
|---|---|---|---|---|---|
| Uber | https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff%5Blatitude%5D=51.4723&dropoff%5Blongitude%5D=-0.488&dropoff%5Bnickname%5D=Heathrow+Terminal+5&dropoff%5Bformatted_address%5D=Wallis+Rd%2C+Hounslow+TW6+2GA | | | | |
| Uber (name only — does Uber find the place?) | https://m.uber.com/ul/?action=setPickup| Lyft |pickup=my_location| Lyft |dropoff%5Bnickname%5D=Dishoom+Shoreditch| Lyft |dropoff%5Bformatted_address%5D=Dishoom+Shoreditch | | | | |
| Lyft | https://lyft.com/ride?id=lyft&destination%5Blatitude%5D=40.6413&destination%5Blongitude%5D=-73.7781 | | | | |
| Google Maps | https://www.google.com/maps/dir/?api=1&destination=Borough+Market%2C+London&travelmode=walking | | | | |
| OpenTable | https://www.opentable.com/s?term=Dishoom+Shoreditch+London&covers=4&dateTime=2026-10-15T20%3A00 | | | | |
| Resy | https://resy.com/cities/new-york-ny?date=2026-10-15&seats=2&query=Carbone | | | | |
| Spotify | https://open.spotify.com/search/lofi%20beats | | | | |
| Airbnb | https://www.airbnb.com/s/Lisbon%2C%20Portugal/homes?checkin=2026-10-15&checkout=2026-10-18&adults=2 | | | | |
| Booking.com | https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-10-15&checkout=2026-10-18&group_adults=2&no_rooms=1 | | | | |

For each cell, note: opens? / pre-filled? / works?
