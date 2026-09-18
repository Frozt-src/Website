# Monolith

The Monolith website at **https://mnlith.dev**. React and TypeScript provide the interface. Cloudflare Workers Static Assets serves the built site (Worker `monolith-site`), and a separate Cloudflare Worker (`monolith-api`) receives consultation inquiries into a private D1 database.

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

The site is an assets-only Cloudflare Worker named `monolith-site` (`wrangler.jsonc`), serving `dist/` on the Custom Domain `mnlith.dev`. It has no Worker script, so page and asset requests are free and don't count toward Worker request limits. The build writes `dist/_headers` (see `vite.config.ts`). It sets the Content-Security-Policy, HSTS, frame, referrer, permissions and opener headers, plus long-lived caching for hashed `/assets/*`. Unknown paths return `404.html` with status 404. `www.mnlith.dev` redirects to the apex through a Cloudflare Redirect Rule, not code.

With Node 24 and Wrangler signed in to the Cloudflare account that owns `mnlith.dev` (`npx wrangler login`, then `npx wrangler whoami`):

**First deploy only:** follow `docs/cloudflare-cutover.md` and run the first deploy only at its step 2. Until then, if Wrangler offers to replace existing DNS records for `mnlith.dev`, answer **No**.

    npm ci
    npm run deploy:check   # build + wrangler dry run
    npm run deploy         # tests, build, deploy
    npm run verify:site    # checks headers, caching, 404, privacy page and security.txt on https://mnlith.dev
    npm run api:deploy     # inquiry API (separate Worker): run whenever api/ changes

To roll back instantly, run `npx wrangler rollback` (or Workers & Pages → monolith-site → Deployments); `npx wrangler rollback --config api/wrangler.jsonc` does the same for the API. Deploy the site in one step with `npm run deploy`, never as a gradual percentage rollout, because hashed `/assets/*` responses (including 404s) are cached for a year. `VITE_API_URL` is an optional public build-time override for the API address, never a secret. The CSP's `connect-src` follows it.

Optional: connect the repository in Cloudflare → Workers & Pages → monolith-site → Settings → Builds (Workers Builds, which works with private repositories), with build command `npm test && npm run build` and deploy command `npx wrangler deploy`. Then pushes to `main` deploy the site automatically. The API still deploys with `npm run api:deploy`. GitHub Actions isn't used.

The one-time move from GitHub Pages is documented in `docs/cloudflare-cutover.md`.

The backend is deployed separately with `npm run api:deploy` after the database migration and `RATE_LIMIT_SECRET` are configured. See the backend documentation for provisioning and verification.

## Receiving inquiries

Website inquiries are stored privately in Cloudflare D1 under `monolith-inquiries`. They are emailed to eldritch@mnlith.dev only after the notification binding is activated (see `api/README.md`). Until then, review them in D1. Open Cloudflare → Storage & databases → D1 → monolith-inquiries → Console to review them with:

```sql
SELECT id, datetime(created_at, 'unixepoch') AS received_utc,
       name, email, company, service, team_size, message
FROM inquiries
ORDER BY created_at DESC
LIMIT 50;
```

There is no public inbox endpoint. The daily scheduled job deletes inquiries older than 90 days and expired rate-limit records. Cloudflare provider backups and service logs follow its own policies. Direct email links open the visitor's email application.

## Application platform (app/)

`app/` holds a separate application: an opaque-link payment page, an authenticated client portal, a server-side API, and its own D1 database (`monolith-app`), built as a third Cloudflare Worker distinct from the marketing site and the inquiry API. It is **not deployed yet** — there is no production Worker, D1 database, Custom Domain, or webhook configured for it. See `app/README.md` for how to run it locally, its security model, and the checklist the owner still needs to complete before it goes live.

## Source and assets

- `src/`: frontend components, content, styles and motion.
- `public/images/`: original AI-generated conceptual brand imagery, optimized for the web; these do not depict actual Monolith facilities.
- `api/`: Worker source, database schema and tests.
- `docs/research/`: market research, sources and limits of profitability comparisons.
- `docs/superpowers/`: design and implementation decisions.
- `privacy.html`, `404.html`, `src/pages.css`: the privacy notice and not-found pages.
- `public/.well-known/security.txt`: security contact (renew `Expires` before 2027-09-17).

The original Grym Studios page remains in Git history before the Monolith launch. All iCloud email records remain independent of website hosting.
