# Monolith

The Monolith website at **https://mnlith.dev**. React and TypeScript provide the interface; GitHub Pages hosts the built site. A separate Cloudflare Worker receives consultation inquiries into a private D1 database.

## Work locally

Use Node 24 and npm.

```sh
npm ci
npm run dev
```

The development server serves the frontend. Production inquiry origins are intentionally restricted; local form testing against the production backend is not allowed. Backend tests use a SQLite-backed D1 adapter and synthetic records.

```sh
npm test
npm run build
npm run api:check
```

## Publish

GitHub Pages currently publishes prebuilt files from **`gh-pages` / (root)**. GitHub Actions execution was blocked by account billing during launch, so pushes to `main` do not automatically publish. Source remains on `main`; the built site lives on `gh-pages`.

With Node 24, Git, and an authenticated GitHub CLI account that can push this repository, run:

```sh
npm ci
npm run publish:pages
```

This checks the Pages configuration, runs tests and builds, clones `gh-pages` into a fresh `.deploy/pages-*` directory, replaces only that temporary checkout's site files, commits the result, pushes without force, and requests a Pages build. The checkout remains available for inspection. If another deployment changes `gh-pages` during publication, the push fails safely; rerun the command to build from the latest branch. A queued build is not proof the site is live: verify the GitHub Pages build status and https://mnlith.dev afterward.

`public/CNAME` retains `mnlith.dev`, and GitHub enforces HTTPS. The frontend defaults to `https://api.mnlith.dev`; an optional local `VITE_API_URL` override is a public service address, never a secret.

After resolving account billing, restore workflow deployment by changing the Pages build source to GitHub Actions and enabling the `main` push trigger in `.github/workflows/pages.yml` (currently manual `workflow_dispatch` only). Set repository variable `VITE_API_URL` if overriding the default, then run the workflow and verify the deployed site. Stop using `publish:pages` after switching sources; it intentionally refuses to publish unless Pages still uses `gh-pages` /.

The backend is deployed separately with `npm run api:deploy` after the database migration and `RATE_LIMIT_SECRET` are configured. Do not publish with the placeholder database UUID. See the backend documentation for provisioning and verification.

## Receiving inquiries

Website inquiries are stored privately in Cloudflare D1 under `monolith-inquiries`. They are **not automatically emailed**. Open Cloudflare → Storage & databases → D1 → monolith-inquiries → Console to review them with:

```sql
SELECT id, datetime(created_at, 'unixepoch') AS received_utc,
       name, email, company, service, team_size, message
FROM inquiries
ORDER BY created_at DESC
LIMIT 50;
```

There is no public inbox endpoint. The daily scheduled job deletes inquiries older than 90 days and expired rate-limit records. Cloudflare provider backups and service logs follow its own policies. Direct email links open the visitor's email application.

## Source and assets

- `src/`: frontend components, content, styles and motion.
- `public/images/`: original AI-generated conceptual brand imagery, optimized for the web; these do not depict actual Monolith facilities.
- `api/`: Worker source, database schema and tests.
- `docs/research/`: market research, sources and limits of profitability comparisons.
- `docs/superpowers/`: design and implementation decisions.

The original Grym Studios page remains in Git history before the Monolith launch. All iCloud email records remain independent of website hosting.
