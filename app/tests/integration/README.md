# Gated integration harness

These suites talk to a **real Clerk development instance** and **real Stripe test mode** through a
Worker running locally. They are deliberately **not** part of `npm test`: they need credentials,
a running Worker, a running `stripe listen`, and — for the payment and sign-in pages — a person at
a browser.

Nothing here ever touches live credentials. `app/tests/integration/env.ts` refuses to run unless
`STRIPE_SECRET_KEY` starts with `sk_test_` and `CLERK_SECRET_KEY` starts with `sk_test_`, and the
only database it reads or writes is the local one under `app/.wrangler/state`.

When a precondition is missing the whole run **skips with the reason printed** and exits 0, so it
is safe to run at any time:

```
$ npm run app:test:integration
﹣ checkout hands off to a Stripe session that matches the local payment row (0.07ms) # app/.dev.vars not found — copy app/.dev.vars.example and fill in test-mode keys
...
ℹ skipped 17
```

## Preconditions the harness checks

| Precondition | Skip reason when missing |
|---|---|
| `app/.dev.vars` exists | `app/.dev.vars not found — copy app/.dev.vars.example and fill in test-mode keys` |
| `STRIPE_SECRET_KEY` is a real `sk_test_` key | `app/.dev.vars has no real STRIPE_SECRET_KEY (still the .dev.vars.example placeholder)` |
| `STRIPE_WEBHOOK_SECRET` is a real `whsec_` secret | as above, for `STRIPE_WEBHOOK_SECRET` |
| `CLERK_SECRET_KEY` is a real `sk_test_` key | as above, for `CLERK_SECRET_KEY` |
| a Worker answers `GET /healthz` on `127.0.0.1:8788` with `Host: pay.localhost` | ``no Worker on http://127.0.0.1:8788 (connect ECONNREFUSED 127.0.0.1:8788) — run `npm run app:dev` `` |

One precondition **cannot** be checked from here: `stripe listen` has to be forwarding webhooks to
the local Worker. Nothing tells the test whether it is running, so a step that depends on a webhook
waits and then fails with a message naming `stripe listen --forward-to
127.0.0.1:8788/api/stripe/webhook`.

## Runbook

### 1. Credentials (once)

Copy `app/.dev.vars.example` to `app/.dev.vars` (git-ignored) and fill in:

- `CLERK_SECRET_KEY` — the **development** instance's secret key (`sk_test_…`) from the Clerk
  dashboard. Set `CLERK_PUBLISHABLE_KEY` and `CLERK_FRONTEND_API_URL` in the `dev` env of
  `app/wrangler.jsonc` from the same instance, or the portal renders "Portal is not configured".
- `STRIPE_SECRET_KEY` — a Stripe **test mode** secret key (`sk_test_…`). Enable `card` and
  `us_bank_account` for Checkout in the Stripe dashboard.
- `STRIPE_WEBHOOK_SECRET` — filled in at step 3.

### 2. Database, portal build, Worker

```sh
npm run app:migrate:local   # local D1 only (app/.wrangler/state)
npm run app:build           # portal SPA into app/dist/portal
npm run app:dev             # wrangler dev on 127.0.0.1:8788, leave running
```

### 3. Webhook forwarding

In a second terminal:

```sh
stripe login
stripe listen --forward-to 127.0.0.1:8788/api/stripe/webhook
```

`stripe listen` prints a `whsec_…` signing secret **of its own** — it is not the dashboard endpoint
secret. Copy it into `STRIPE_WEBHOOK_SECRET` in `app/.dev.vars` and **restart `npm run app:dev`**,
because wrangler reads `.dev.vars` at start-up. Leave `stripe listen` running.

### 4. Run

```sh
npm run app:test:integration                              # automated steps only
MONOLITH_INTEGRATION_MANUAL=1 npm run app:test:integration # + the browser steps
```

Without `MONOLITH_INTEGRATION_MANUAL=1` every step that needs a person is skipped with
`manual step — set MONOLITH_INTEGRATION_MANUAL=1 to run it`, so the run finishes in seconds.

### 5. The manual steps

With `MONOLITH_INTEGRATION_MANUAL=1` the run prints a url and then polls the local database every
3 seconds. Each wait has a deadline (10 minutes for the Stripe pages, 5 for the Clerk tickets) and
the timeout message names what it was waiting for.

**Card.** Open the printed Checkout url and pay with Stripe's test card `4242 4242 4242 4242`, any
future expiry date, any 3-digit CVC. The invoice must reach `paid`.

**ACH (success), ACH (failure).** Open the printed Checkout url, choose the US bank account method
and enter the details manually (rather than linking a test institution): routing number
`110000000`, account number `000123456789` for the payment that succeeds and `000222222227` (an
insufficient-funds account) for the one that fails. A manually entered test account is verified
with microdeposits — use the amounts `32` and `45`, or the `0.01` descriptor code `SM11AA`. The
successful invoice goes `processing` then `paid`; the failing one goes `processing` then back to
`open` with its payment `failed`. Instant verification instead of manual entry is also possible —
in test mode the linking flow only offers Stripe's own test institutions (`Test (Non-OAuth)`,
`Bank (Non-OAuth)`) and no credentials are needed.

**Clerk tickets.** The run prints three sign-in urls of the form
`http://localhost:8788/?__clerk_ticket=<token>` (valid for 10 minutes). Open each in a browser:

| Address | Expected |
|---|---|
| `bound+clerk_test@example.com` | signs in, portal loads, membership becomes `active` |
| `nobody+clerk_test@example.com` | signs in, portal shows the no-account screen (`GET /api/me` → 403 `no_account`) |
| `unverified@example.com` | signs in, same no-account screen — the email is deliberately unverified |

Any email verification code a `+clerk_test` address is asked for is `424242`; no mail is sent.

The membership binding is also asserted without a browser when the Clerk instance mints session
JWTs the Worker accepts. It often does not: the Worker verifies with an `authorizedParties` list,
and a Backend-API-minted token has no matching `azp` claim. In that case the step reports
`this Clerk instance mints session JWTs the Worker refuses (no matching azp claim) — use the
browser tickets` and the browser tickets are the only proof.

### 6. Reading the results

`node --test` prints one line per step: `✔` passed, `✖` failed (with the assertion), `﹣` skipped
followed by `#` and the reason. The summary at the end counts each. A skipped run is not a passing
run — read the reason. Useful ones:

- `manual step — set MONOLITH_INTEGRATION_MANUAL=1 to run it` — expected in an unattended run.
- `no checkout.session.completed has reached the local Worker yet — run the card step first` — the
  replay step has nothing to replay because no card payment has been completed on this database.
- `timed out after 600s waiting for … (is \`stripe listen --forward-to
  127.0.0.1:8788/api/stripe/webhook\` running?)` — the hosted page was completed but no webhook
  arrived, or the `whsec_` in `.dev.vars` is not the one `stripe listen` printed.

### 7. Cleaning up

Everything the harness writes locally lives in the local D1, and every run starts by re-seeding it:

```sh
npm run app:seed -- --reset      # drops and recreates the seeded client and its rows
```

To throw the local database away entirely, delete `app/.wrangler/state/v3/d1` and re-run
`npm run app:migrate:local`. There is no remote clean-up to do: no step here has a `--remote` path.

Stripe test mode keeps the Checkout Sessions, PaymentIntents and events the run created. They are
sandbox objects and cost nothing; delete the sandbox in the Stripe dashboard if you want them gone.
Clerk keeps the three development users — the harness reuses them on the next run rather than
creating more, and they can be deleted from the Clerk dashboard.

## Notes on how it is wired

- **`--test-concurrency=1`.** Both suites re-seed the same local database, so `node --test` must
  run the files one after another rather than in parallel processes.
- **`Host` headers, not `fetch`.** `wrangler dev` serves the pay host and the portal host on one
  port and routes on the `Host` header, and Node's `fetch` refuses to send that header, so
  `env.ts` makes its requests with `node:http`. It never follows redirects either, which is what
  makes the `303` to Stripe observable.
- **`local-d1.ts`** reads and writes the same database the Worker is using, through
  `wrangler d1 execute --local --json`. The Worker holds that SQLite file open while it runs; if a
  query ever comes back busy, re-run it.
- **`app/scripts/seed-dev.mjs --json`** prints the seeded ids, tokens and pay urls as one JSON
  object, and each `--extra-invoice` adds a further open invoice with its own payment link, so a
  step that consumes an invoice (pays it, revokes its link, voids it) never shares one.

## Where the test values come from

| Value | Source |
|---|---|
| Card `4242 4242 4242 4242`, any future expiry, any CVC | <https://docs.stripe.com/testing> |
| Routing `110000000`; account `000123456789` succeeds, `000222222227` fails (insufficient funds); microdeposits `32`/`45`, descriptor `SM11AA` | <https://docs.stripe.com/payments/ach-direct-debit/accept-a-payment?payment-ui=checkout> |
| Test institutions in the bank-linking flow need no credentials | <https://docs.stripe.com/financial-connections/testing> |
| `stripe events resend <event_id>` re-delivers an event to the CLI's forwarding endpoint | <https://docs.stripe.com/cli/events/resend> |
| `+clerk_test` addresses are development-instance test addresses and accept the code `424242` | <https://clerk.com/docs/guides/development/testing/test-emails-and-phones> |
| A sign-in ticket is consumed through the `__clerk_ticket` query parameter | <https://clerk.com/docs/guides/users/impersonation> |
