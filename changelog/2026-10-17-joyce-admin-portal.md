Admins now have a Joyce portal, in terracotta, with requests Joyce couldn't handle, a to-do list, her log lines and her API spend.

It's at `/joyce-portal` and in the sidebar for admins, under Marlowe's Portal. It mirrors the
Portal's layout and uses the same components (`client/src/pages/PortalPage.tsx`), which now take
the set of server calls to use, so a fix to one portal's section fixes the other's.

- **Flagged requests.** Joyce has a new `flag_unmet_request` tool, like Marlowe's. When a family
  asks for something she can't do, she records a one-line summary, told to leave out names and
  personal details, with an anonymous family label such as "Family 3F9A2C". The label is the same
  for every request from one family but doesn't reveal which family it is. Admins can add notes
  and mark requests resolved.
- **To-do list.** Separate from Marlowe's. The existing `admin_todos` table gained a `product`
  column; everything already in it stays on Marlowe's list.
- **Logs.** Only lines starting `joyce:`, with the same "Explain this" button.
- **Usage.** Joyce's Claude spend wasn't tracked before. Every call she makes (replying, and
  reading photos and files) is now recorded in `data/joyce/admin.db` with token counts, and shown
  with an approximate cost. No family is attached to usage, so there's no per-family breakdown.

Server: `server/src/routes/joycePortalRoutes.ts` (mounted at `/api/joyce-portal`, admin-only) and
`server/src/joyce/adminRecords.ts`. See "Admin portal" in `feature-to-do/joyce-family-assistant.md`
for the privacy trade-off in flagged requests.
