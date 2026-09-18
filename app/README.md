# Monolith application platform (`app/`)

The billing application: an opaque-link payment page (`pay.mnlith.dev`), an authenticated client
portal (`portal.mnlith.dev`), a server-side Hono API, and a dedicated D1 database
(`monolith-app`). It is a separate Cloudflare Worker from the marketing site (`monolith-site`)
and the inquiry API (`monolith-api`), and it is **not deployed yet** — see the activation
checklist below.

## Three data domains (never merged)

| Domain | Store | Owner of truth |
|---|---|---|
| PSA data (tickets, companies, contacts, agreements) | ConnectWise Manage | outside this repo; not integrated |
| Public website inquiries | D1 `monolith-inquiries` (Worker `monolith-api`) | existing, untouched by this app |
| Portal, invoices, payments, memberships | D1 `monolith-app` (this Worker) | authoritative for the billing domain |

## Repo layout

- `src/` — the Worker. `index.ts` (env wiring), `app.ts` (hostname routing), `deps.ts`
  (`AppDeps`, the interface every handler is written against so tests can inject fakes),
  `auth/` (Clerk session verification, membership binding, the portal auth middleware),
  `domain/` (pure D1 access and business logic: clients, invoices, payment links, payments,
  money, ids, tokens, audit), `http/` (Hono route handlers for the portal API, the pay host, and
  the Stripe webhook), `pay/` (server-rendered HTML for the pay host), `stripe/` (the Stripe SDK
  gateway and webhook signature verification — the only files besides `auth/clerk.ts` allowed to
  import `stripe` or `@clerk/backend`).
- `portal/` — the Vite + React 19 client portal SPA (`src/`, built to `dist/portal` and served by
  the Worker's `ASSETS` binding on the portal host).
- `migrations/` — versioned D1 schema migrations (`wrangler d1 migrations apply`).
- `tests/` — `node --test` suites; `tests/helpers/` holds the SQLite-backed D1 adapter and
  fixture builders shared across them.
- `scripts/seed-dev.mjs` — local dev seed data (see below).
- `wrangler.jsonc` — Worker config: hostnames, D1 binding, the `dev` environment used locally.
- `.dev.vars.example` — placeholder secrets; copy to `.dev.vars` (git-ignored) for local dev.

## Running locally

```sh
npm ci
npm run app:migrate:local   # applies migrations to the local D1 (.wrangler/state), never remote
npm run app:seed            # seeds a demo client; prints a pay URL and the invited email
npm run app:build           # builds the portal SPA to app/dist/portal
npm run app:dev             # wrangler dev on http://127.0.0.1:8788
```

Then open the pay URL `app:seed` printed (e.g. `http://pay.localhost:8788/i/<token>`) and
`http://localhost:8788/` for the portal. `app:migrate:local` and `app:seed` only ever touch the
local D1 under `app/.wrangler/state`; neither takes a `--remote` flag.

Without `STRIPE_SECRET_KEY` set, everything except paying still works — clicking "Pay invoice"
renders a 503 "payments are not available right now" page instead of creating a Checkout Session.

## Portal preview mode

`npm run app:portal:preview` runs the portal's own Vite dev server (`--mode preview`) and renders
every screen from in-memory fake data (`portal/src/preview.ts`), so the UI can be reviewed without
Clerk credentials or a running Worker. It only exists in dev mode; the code path is tree-shaken
out of `npm run app:build`'s production output.

## Tests

`npm test` (from the repo root) runs `app/tests/*.test.ts` with `node --test`, using real SQLite
(`node:sqlite`) against the real migration files, with Clerk and Stripe replaced by fakes injected
through `createApp(deps: AppDeps)`. No network access, no real credentials.

## Environment and secrets

Public config lives in `app/wrangler.jsonc` (`vars`): `PAY_HOST`, `PORTAL_HOST`, `ADMIN_HOST`,
`STRIPE_MODE`, `CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API_URL`. None of these are secret — the
publishable key is served to the portal at `GET /api/public-config`.

Secrets go in `app/.dev.vars` (git-ignored; copy from `.dev.vars.example`), **test-mode keys
only, never live keys**:

| Key | Purpose |
|---|---|
| `CLERK_SECRET_KEY` | Clerk Backend API access (user lookup on first login). |
| `CLERK_JWT_KEY` | Optional. When set, session JWTs are verified networkless; otherwise the JWKS is fetched with the secret key. |
| `STRIPE_SECRET_KEY` | Creates Stripe Checkout Sessions. Unset: paying is disabled (503), everything else still works. |
| `STRIPE_WEBHOOK_SECRET` | Verifies `POST /api/stripe/webhook` signatures. Unset: the webhook route always answers `invalid_signature`. |

## Security model

- **Hostname routing**: `createApp` reads the request's hostname and dispatches to the pay app or
  the portal app; any other host gets a generic 404. The two apps share no routes — the pay host
  never serves the portal's static assets, and the portal host has no invoice-rendering routes.
- **Tenant scoping**: every portal API query is scoped by the caller's `client_id`, resolved from
  their bound Clerk session. A resource belonging to another client returns 404, never 403 —
  nothing about the response distinguishes "not yours" from "doesn't exist".
- **Token design**: payment-link tokens are 32 cryptographically random bytes, base64url-encoded
  (43 characters). D1 stores only the SHA-256 hex digest (`payment_links.token_hash`); the
  plaintext token is never logged, stored, or put in an audit row. Exactly one active link per
  invoice is enforced by a partial unique index; issuing a new link revokes the old one in the
  same batch. Malformed, unknown, revoked, or void-invoice tokens all render the same generic 404;
  a paid invoice renders a distinct "already paid" page (number, amount, paid date) with no
  payment action.
- **Webhook idempotency**: `payment_events.stripe_event_id` is `UNIQUE`. The event-insert and
  every resulting state change are written in one atomic `db.batch()`, so a replayed event either
  applies nothing (the unique violation is caught and reported as a no-op) or applies everything —
  never half of it. State transitions are conditional updates (`WHERE status IN (...)`), so
  out-of-order delivery cannot regress an invoice or payment backwards.
- **CSP per host**: the pay host sends
  `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'`
  (no scripts anywhere on that host). The portal host's CSP is built from `'self'` plus the Clerk
  frontend API origin (`CLERK_FRONTEND_API_URL`), the minimum Clerk's hosted UI requires.

## State machines

**Invoice status** (`draft`, `open`, `processing`, `paid`, `void`):

| From | Trigger | To |
|---|---|---|
| `draft` | issued (reserved admin API, not implemented in Phase 1) | `open` |
| `open` | Checkout completes and is already paid (card) | `paid` |
| `open` | Checkout completes but payment is still settling (ACH) | `processing` |
| `processing` | async payment succeeds | `paid` |
| `processing` | async payment fails | `open` |
| `open` / `processing` | voided (reserved admin API, not implemented in Phase 1) | `void` |

**Payment status** (`pending`, `processing`, `succeeded`, `failed`, `canceled`, one row per Stripe
Checkout Session):

| From | Trigger | To |
|---|---|---|
| `pending` | `checkout.session.completed`, already paid | `succeeded` |
| `pending` | `checkout.session.completed`, not yet paid (ACH) | `processing` |
| `processing` | `checkout.session.async_payment_succeeded` | `succeeded` |
| `pending` / `processing` | `checkout.session.async_payment_failed` | `failed` |
| `pending` | `checkout.session.expired`, or superseded by a new Checkout Session for the same invoice | `canceled` |

## Activation checklist (owner, in order — all outside Phase 1)

None of this is done by the code in this repo; it requires Cloudflare, Stripe and Clerk dashboard
access the owner holds.

1. Create a Clerk **development** instance for local/staging work (portal origin, session
   settings); later create a Clerk **production** instance for `https://portal.mnlith.dev`.
2. Create Stripe **test** API keys, and in the Stripe Dashboard enable the `card` and
   `us_bank_account` payment methods for Checkout.
3. Create the remote D1 database: `wrangler d1 create monolith-app`, then set the returned
   `database_id` in `app/wrangler.jsonc`.
4. Set the four secrets on the deployed Worker: `wrangler secret put CLERK_SECRET_KEY`,
   `CLERK_JWT_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`--config app/wrangler.jsonc`).
5. Apply migrations to the remote database:
   `wrangler d1 migrations apply monolith-app --config app/wrangler.jsonc --remote`.
6. Decide on Workers Paid (this Worker has a script, unlike the assets-only site Worker, so it
   counts against request/CPU limits).
7. Add Custom Domains `pay.mnlith.dev` and `portal.mnlith.dev` to the `monolith-app` Worker
   (requires owner DNS approval, as with the original `mnlith.dev` cutover).
8. Configure the Stripe webhook endpoint `https://pay.mnlith.dev/api/stripe/webhook` for the
   events `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`; copy the signing secret
   into `STRIPE_WEBHOOK_SECRET`.
9. Before relying on any of the above, run a full test-mode Checkout end to end with
   `stripe listen --forward-to localhost:8788/api/stripe/webhook` running locally first.

## Privacy notice changes required before activation

The following need to be reflected in the site's privacy notice before this app goes live (no
legal text drafted here — that's the owner's call):

- Clerk added as a data processor (identity provider): what it receives (email address, and any
  other profile fields Clerk collects at sign-in).
- Stripe added as a data processor (payment processor): what it receives (billing email, payment
  method details — handled entirely by Stripe's hosted Checkout, never touching this app's
  servers — and the invoice amount).
- Portal account data this app stores itself: membership email, role and status, and sign-in
  binding metadata.
- Payment records retention: how long `invoices`, `payments` and `payment_events` rows are kept.
- Cookies Clerk sets on the portal host (session and device-recognition cookies) for its own
  authentication flow.
