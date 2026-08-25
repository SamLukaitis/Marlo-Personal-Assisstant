# Drop the now-obsolete `travel_checkins` table once entities/links has proven stable

Phase B of `docs/entities-and-links-todo.md` (2026-08-24) migrated travel check-ins into the new
generic `entities` table — `saveCheckin`/`listCheckins`/`listAllCheckinsAscending` in
`server/src/db/store.ts` now read and write `entities` (type='travel_checkin'), not the raw table.
The old `travel_checkins` table itself was deliberately left in place, untouched, purely as a
rollback point — it's frozen at whatever it held at the moment of first migration and no longer
receives new writes. Once the entities-backed path has run in production for a while with no
issues, come back and: drop the `travel_checkins` table + its migration code in `store.ts`, and
remove the now-pointless `CheckinSource`/rebuild-migration comments that reference it.
