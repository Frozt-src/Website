# Application Platform Phase 1.5 (integration validation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Phase 1 architecture, and make it provable with real development/test integrations: purge the last vendor references, add explicit staging/production database environments, close the concurrent-checkout race with a database invariant, add lightweight checkout abuse control, bring test sources under typechecking, and ship a gated integration harness that exercises a real Clerk development instance and real Stripe test mode against the local Worker runtime.

**Architecture:** Unchanged from Phase 1 (`docs/superpowers/specs/2026-09-18-app-platform-phase1-design.md`). Additions: migrations `0003` (single open payment per invoice) and `0004` (checkout attempt counters); `env.staging` in `app/wrangler.jsonc`; `app/tests/integration/` (skipped unless real keys and a running Worker are present); scripts under `app/scripts/`.

**Tech Stack:** as Phase 1. Stripe CLI (`stripe listen`) used only during the live validation step, by the controller.

**Spec:** `docs/superpowers/specs/2026-09-18-app-platform-phase1-design.md` plus the owner's Phase 1.5 brief (summarised in Global Constraints).

## Global Constraints

- Branch `app-platform-phase1` (continues from PR #4 head `e3b9c65`). Commit after each task. Never push, never deploy (dry runs only), never `wrangler login`, never write to any remote D1 except `monolith-app-staging` and only when a task says so, never touch Cloudflare/GitHub/Stripe/Clerk settings, never live Stripe.
- **The PSA vendor formerly mentioned in docs must not appear anywhere in the repository after Task 1: not in code, comments, docs, specs, plans, research notes or commit messages.** Task 1 removes every occurrence; later tasks must not reintroduce it.
- Do not modify `api/`, `src/`, `index.html`, `privacy.html`, `404.html`, root `wrangler.jsonc`, `vite.config.ts`, `scripts/verify-site.mjs`, `public/`.
- No secrets in git. Real keys only in `app/.dev.vars` (git-ignored). Placeholders only in `app/.dev.vars.example`.
- No new npm dependencies. Worker binding names stay `DB` and `ASSETS`.
- Invariant (Task 3): one invoice → at most one payment row in `('pending','processing')` → at most one live Stripe Checkout Session. Enforced by the database, not process memory.
- Existing tests keep passing; `npm test`, `npm run typecheck`, `npm run app:check` green at the end of every task.
- Style as Phase 1. Commit messages end with a Co-Authored-By trailer.

---

### Task 1: Remove every vendor reference

**Files:** `app/README.md` (data-domain table row), `docs/superpowers/specs/2026-09-18-app-platform-phase1-design.md` (two occurrences), `docs/superpowers/plans/2026-09-18-app-platform-phase1.md` (three occurrences), `docs/research/2026-09-17-it-services-market.md` (one occurrence).

- [ ] Rewrite each sentence so the meaning survives without the vendor name: in the data-domain tables say "PSA data (tickets, companies, contacts, agreements) | external PSA system used by the MONOLITH internal app | outside this repo; not integrated"; in constraint lines say "no external PSA/CRM vendor integration is in scope"; in the research note say "owned by an MSP software vendor". Do not delete the surrounding content.
- [ ] Verify: `git grep -il <vendor-name>` (the name is given in your dispatch, not written here) prints nothing — the word must not appear anywhere in tracked files.
- [ ] Commit: `Remove vendor references from documentation`.

---

### Task 2: Explicit staging and production database environments

**Files:** `app/wrangler.jsonc`, `package.json` (scripts), `app/scripts/seed-dev.mjs` (env flag), `app/README.md` (environments section), `app/.dev.vars.example` (note about `.dev.vars.staging`).

- [ ] `app/wrangler.jsonc`: top level is **production**: `name: "monolith-app"`, D1 `database_name: "monolith-app-production"`, `database_id: "00000000-0000-0000-0000-000000000000"` (placeholder until the owner creates it), hosts `pay.mnlith.dev` / `portal.mnlith.dev` / `admin.mnlith.dev`, `workers_dev: false`, `preview_urls: false`. `env.staging`: `name: "monolith-app-staging"`, D1 `database_name: "monolith-app-staging"`, `database_id: "<STAGING_ID>"` (the controller supplies the real id in the dispatch), hosts `pay-staging.mnlith.dev` / `portal-staging.mnlith.dev` / `admin-staging.mnlith.dev` (placeholders; no DNS), `workers_dev: false`, `preview_urls: false`, same `vars` keys with `STRIPE_MODE: "test"`. `env.dev`: as today (local hosts) but its D1 entry points at `monolith-app-staging` with the same `<STAGING_ID>` (local emulation ignores the id; a future `--remote` dev session then hits staging, never production). Keep `assets`, `observability`, `compatibility_*` at top level (inherited).
- [ ] `package.json` scripts: keep `app:dev`, `app:migrate:local` (dev, `--local`); add `"app:migrate:staging": "wrangler d1 migrations apply monolith-app-staging --remote --config app/wrangler.jsonc --env staging"`, `"app:check": "npm run typecheck && npm run app:build && wrangler deploy --dry-run --config app/wrangler.jsonc && wrangler deploy --dry-run --config app/wrangler.jsonc --env staging"`, `"app:deploy:staging": "npm test && npm run app:build && wrangler deploy --config app/wrangler.jsonc --env staging"` (documented; never run in this plan).
- [ ] `app/scripts/seed-dev.mjs`: keep default local behaviour; add `--staging` which targets `--remote --env staging` and refuses unless `--i-understand-remote-staging` is also passed; never allow a production target (no flag exists). Update its usage text.
- [ ] `app/README.md`: an "Environments" section with the table dev (local D1 emulation) / staging (`monolith-app-staging`, test keys, `.dev.vars.staging`) / production (`monolith-app-production`, placeholder id, real keys only via `wrangler secret put`), and the rule "test data never shares a database with production billing data".
- [ ] Verify: `npx wrangler deploy --dry-run --config app/wrangler.jsonc` and `--env staging` and `--env dev` all exit 0 and print the expected `database_name`; `npm test && npm run typecheck`.
- [ ] Commit: `Add staging and production database environments`.

---

### Task 3: Single open checkout per invoice (database-enforced) + deterministic concurrency test

**Files:** `app/migrations/0003_payments_single_open.sql`, `app/src/domain/payments.ts`, `app/src/deps.ts` (`sleep`), `app/src/index.ts`, `app/tests/helpers/app.ts` (fake sleep + deferrable gateway), `app/tests/payments.test.ts`, `app/tests/migrations.test.ts`, `app/README.md` (state machine note).

- [ ] Migration `0003_payments_single_open.sql`: `CREATE UNIQUE INDEX payments_one_open ON payments(invoice_id) WHERE status IN ('pending', 'processing');`
- [ ] `AppDeps` gains `sleep(ms: number): Promise<void>` (production: `setTimeout`; test helper: yields to the macrotask queue with `setTimeout(0)`, counting calls).
- [ ] `startCheckout` becomes two-phase so the index serialises concurrent starts:
  1. Read the open payment for the invoice (status in pending/processing). Existing rules stay: same-source unexpired pending with a `checkout_url` → return it; cross-source → expire + cancel in a batch (as today); expired → cancel.
  2. **Claim:** insert the new `payments` row with `status = 'pending'`, `stripe_checkout_session_id = 'claim:' || payment.id` (unique placeholder), `checkout_url = NULL`, in the same batch as any cancellation. If the insert fails with a UNIQUE violation on `payments_one_open`, another request won the claim: re-read the open row up to 10 times with `deps.sleep(150)` between reads until it has a `checkout_url`; return that url when the sources match, else throw `payment_in_progress`; if it never gets a url, throw `payment_in_progress`.
  3. Create the Stripe session (idempotency key = payment id) and `UPDATE payments SET stripe_checkout_session_id = ?, checkout_url = ? WHERE id = ? AND status = 'pending'`. If Stripe throws, `UPDATE payments SET status = 'canceled', failed_at = ? WHERE id = ?` (frees the claim) and rethrow.
  Webhook handling is unchanged: claim placeholders never match a Stripe session id, and the amount check still applies.
- [ ] Tests (TDD): migration test asserts a second open payment for the same invoice throws; `payments.test.ts`: **deterministic concurrency** — gateway fake whose `createCheckoutSession` returns a promise the test resolves later; start two `startCheckout` calls concurrently (`Promise.all`) for the same invoice/source; assert exactly one gateway call, both callers resolve to the same url, exactly one row in `('pending','processing')`, and `sleep` was called by the loser. Variant: loser with a different source → `payment_in_progress`. Variant: Stripe throws → row `canceled`, no open row remains, a retry succeeds. Existing reuse/expiry tests keep passing (adjust fixtures for the placeholder id: use `cs_test_…` ids from the fake after the update).
- [ ] Verify with `npm test && npm run typecheck && npm run app:check`; commit: `Enforce a single open checkout per invoice with a database invariant`.

---

### Task 4: Lightweight checkout abuse control

**Files:** `app/migrations/0004_checkout_attempts.sql`, `app/src/domain/throttle.ts`, `app/src/http/pay.ts`, `app/src/http/portal-api.ts`, `app/src/pay/render.ts` (one "too many attempts" page), `app/tests/pay.test.ts`, `app/tests/portal-invoices.test.ts`, `docs/app-api-contract.md`, `app/README.md`.

- [ ] Migration: `CREATE TABLE checkout_attempts (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL); CREATE INDEX checkout_attempts_window ON checkout_attempts(window_start);`
- [ ] `throttle.ts`: `allowCheckoutAttempt(db, now, key, limit = 10, windowSeconds = 600): Promise<boolean>` using one atomic UPSERT (same pattern as the inquiry API's rate limiter: insert-or-update with the window reset, `WHERE window_start <= ? OR count < ?`, `RETURNING count`) plus a cheap `DELETE FROM checkout_attempts WHERE window_start < ?` (now − 86400) run at most once per call. Keys: pay host `link:<payment_link_id>`; portal `member:<membership_id>`. Only **POST checkout** requests count (page views do not).
- [ ] Pay host: over the limit → `429` HTML page "Too many payment attempts. Please wait a few minutes and try again." (branded, contact line). Portal: `429 {error:'too_many_attempts', retryAfterSeconds}`; both set `Retry-After`.
- [ ] Tests: the 11th POST within the window → 429 and no gateway call; window expiry restores access; counters are per link / per member (another link is unaffected). Document in the API contract and README (also that CAPTCHA is deliberately not used).
- [ ] Commit: `Throttle checkout attempts per payment link and portal member`.

---

### Task 5: Test sources under typechecking

**Files:** `app/tests/tsconfig.json` (new), `package.json` (`typecheck`), test files as needed, `app/README.md` (Testing section).

- [ ] Create `app/tests/tsconfig.json` extending the same compiler options as `app/tsconfig.json` but with `"types": ["node", "@cloudflare/workers-types"]`, `"lib": ["ES2022"]`, `"include": ["./**/*.ts", "../src/**/*.ts"]`, `allowImportingTsExtensions`, `noEmit`. Add `&& tsc --noEmit -p app/tests/tsconfig.json` to `typecheck`.
- [ ] Fix the type errors it surfaces in tests with the smallest correct change (typed fakes, `satisfies`, narrow casts). If the Node and Workers global type sets conflict in a way that cannot be resolved without weakening source types (e.g. `Response`/`Request` incompatibilities), stop and document the exact compiler errors and the attempted configurations in `app/README.md` under "Why test sources are not typechecked", and remove the script change — but only after trying `"types": ["node"]` alone with `/// <reference types="@cloudflare/workers-types" />` in `app/tests/helpers/d1.ts`, and `skipLibCheck`.
- [ ] Verify `npm run typecheck && npm test`; commit: `Typecheck app test sources`.

---

### Task 6: Gated integration harness (real Clerk dev instance + real Stripe test mode)

**Files:** `app/tests/integration/README.md`, `app/tests/integration/env.ts` (loads `app/.dev.vars`, decides `skip`), `app/tests/integration/stripe.integration.test.ts`, `app/tests/integration/clerk.integration.test.ts`, `app/tests/integration/local-d1.ts` (reads the local D1 via `wrangler d1 execute --local --json`), `app/scripts/seed-dev.mjs` (`--json`, `--email`, `--extra-invoice` options), `package.json` (`app:test:integration`), `app/README.md`.

Preconditions the harness checks (and skips with a clear message when absent): `app/.dev.vars` has `STRIPE_SECRET_KEY` (`sk_test_`), `STRIPE_WEBHOOK_SECRET`, `CLERK_SECRET_KEY`; a Worker answers `http://127.0.0.1:8788/healthz` with `Host: pay.localhost`; `stripe listen --forward-to 127.0.0.1:8788/api/stripe/webhook` is running (the test cannot verify this directly; it documents it and times out with a clear message when webhooks never arrive).

- [ ] `stripe.integration.test.ts` (uses the real `stripe` SDK with the test key, and HTTP against the local Worker with `Host` headers):
  1. seed (`node app/scripts/seed-dev.mjs --reset --json`) → token; `GET /i/<token>` 200.
  2. `POST /i/<token>/checkout` → 303; `Location` matches `^https://checkout\.stripe\.com/`; retrieve the session via the SDK: `amount_total === 42500`, `currency === 'usd'`, `client_reference_id === invoice id`, `metadata.payment_id` matches the local `payments` row; the row's `stripe_checkout_session_id === session.id`.
  3. **Concurrency (real runtime):** two parallel `POST /i/<token>/checkout` requests on a fresh invoice → both 303 with the same `Location`; Stripe `checkout.sessions.list({ limit: 20 })` contains exactly one session whose `metadata.invoice_id` is that invoice; local D1 has one open payment.
  4. **Manual step:** print the Checkout URL and wait (poll local D1 every 3 s, up to 10 minutes) for the payment to become `succeeded` (card) — the controller/owner completes the hosted page with Stripe's documented test card. Then assert invoice `paid`, `payment_events` has an `applied` row for `checkout.session.completed`, `payload_json` contains no `success_url`.
  5. ACH: seed a second invoice + link; checkout; manual completion with Stripe's test bank account for success → assert `processing` then `paid` (poll for `async_payment_succeeded`); third invoice with the failing test bank account → `processing` then `open`, payment `failed`.
  6. Replay: `stripe.events.list` → take the last `checkout.session.completed` id; re-deliver it with `stripe events resend <id>` via the CLI (spawn `stripe`; if the CLI is missing, POST the stored `payload_json` re-signed with the real secret via `generateTestHeaderString`) → webhook returns `{outcome:'duplicate'}` and the event-row count is unchanged.
  7. Wrong secret → 400; stale timestamp (`generateTestHeaderString` with `timestamp` = now − 600) → 400; `livemode: true` event signed with the real secret → `{outcome:'ignored'}`.
  8. Paid invoice: `POST /i/<token>/checkout` → 303 back to `/i/<token>`; revoked link (`UPDATE payment_links SET status='revoked'` via local D1) → 404; void invoice → 404.
- [ ] `clerk.integration.test.ts` (uses `@clerk/backend` with the dev secret key; the browser part is manual):
  1. Creates/ensures three dev users via the Backend API: `bound+clerk_test@example.com` (verified), `nobody+clerk_test@example.com` (verified), `unverified@example.com` (email left unverified via `emailAddresses.updateEmailAddress(id, { verified: false })`), and prints sign-in tickets for each (`signInTokens.createSignInToken({ userId, expiresInSeconds: 600 })`) with the portal URL `http://localhost:8788/?__clerk_ticket=<token>`.
  2. Seeds an `invited` membership for `bound+clerk_test@example.com`.
  3. Manual step: the controller opens each ticket URL in a browser; the test polls local D1 for the membership to become `active` with a `clerk_user_id` (bound user, expect success within 5 minutes) and, for the other two, prints the expected outcome (403 `no_account`) to be confirmed via the browser's `/api/me` response. Automated assertions: membership row bound; audit `membership.bound`; a direct `GET /api/me` with a **Backend-API-minted session JWT** if available — check the SDK for `sessions.getToken(sessionId, template?)`; if the dev instance exposes it, assert 200 for the bound user and 403 for the other two without any browser step.
- [ ] `package.json`: `"app:test:integration": "node --test app/tests/integration/*.integration.test.ts"` (not part of `npm test`).
- [ ] `app/tests/integration/README.md`: exact runbook — `.dev.vars` keys, `npm run app:migrate:local`, `npm run app:build`, `npm run app:dev`, `stripe login`, `stripe listen --forward-to 127.0.0.1:8788/api/stripe/webhook` (copy `whsec_` into `.dev.vars`, restart `app:dev`), then `npm run app:test:integration`; the manual browser steps; how to read results; how to clean up test data (local only).
- [ ] Verify offline: `npm run app:test:integration` skips cleanly with the reason printed when keys are absent; `npm test`, `typecheck` (integration tests included in the tests tsconfig from Task 5), `app:check` green.
- [ ] Commit: `Add gated integration harness for Clerk development and Stripe test mode`.

---

## Live validation (controller, after the owner supplies keys) — not a subagent task

Run the integration runbook end to end with the real Clerk dev instance and Stripe test mode against `wrangler dev`; record every result in the checkpoint report; re-run the CSP/third-party review on the real portal (Clerk resources only) and pay page (no third parties before checkout); confirm no plaintext token persisted (sweep all tables); confirm no secrets in git; list the production gates.
