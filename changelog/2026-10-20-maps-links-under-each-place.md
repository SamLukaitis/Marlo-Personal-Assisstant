Restaurant and other place suggestions now put a short Google Maps link under each place, instead of a block of long, unlabelled links at the end.

## What changed

A "restaurants near me" reply in Arequipa ended with five links like
`https://www.google.com/maps/place//data=!4m2!3m1!1s0x91424b8cc677f007:0x521534ebbeb54f4e`, one after
another, with no way to tell which belonged to which restaurant. Two causes:

- **Long links.** Google Maps Grounding Lite returns place links in that long form.
  `compactMapsUrl` in `server/src/providers/maps.ts` turns them into
  `https://maps.google.com/?cid=<number>`, Google's own short link for the same place (the number
  is the second half of the id in the long link). It's still visibly a Google Maps link, which
  Google's terms ask for, and nothing is stored, unlike the `/go/` short links used for flights
  and hotels.
- **Links all at the end.** The Maps rule in `server/src/ai/assistant.ts` told Marlowe to "list
  the Google Maps links as sources right after your answer". It now says to put each place's
  link on the line directly under that place and to credit Google Maps once at the end ("Source:
  Google Maps"). The general style guide (`server/src/ai/chatVoice.ts`) says the same for any
  list with links: flights, hotels and places alike.

OpenTable, Resy, Uber and other app hand-off links are deliberately not shortened. They rely on
the phone recognising the app's own web address to open the app, which a redirect through
Marlowe's server can break.
