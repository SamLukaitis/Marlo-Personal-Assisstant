# The Marlo website is now the front page

Visitors who open the site's address see the new Marlo website instead of the old sign-in landing page.

How it works (`server/src/index.ts`): `GET /` serves `website/dist/index.html` when the visitor has no
`session` cookie and the URL has no query string. Everyone else falls through to the React app as
before, so signed-in users still go to the assistant, and the sign-in redirects (`/?error=...`,
`/?not_invited=1`) still land on the old page. The old landing and sign-in page is reachable at `/?app=1`.

The website's built files are in `/site-assets/` (not `/assets/`, which belongs to the React client).
The root `npm run build` now builds the website too, so Railway deploys it with no extra setup.
