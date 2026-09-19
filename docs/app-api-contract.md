# Monolith application API contract

Covers the three HTTP surfaces of the `monolith-app` Worker (`app/src/`): the portal API, the pay
host, the Stripe webhook — and the reserved MONOLITH internal-app (staff/admin) contract, which is
documented only and not implemented in Phase 1.

Money is integer cents, currency always `usd`. Timestamps are Unix seconds. IDs are
`crypto.randomUUID()` text.

## Error codes

| Code | Meaning | Where it appears |
|---|---|---|
| `unauthenticated` | Missing or invalid `Authorization: Bearer <session JWT>`. | Portal API, 401 |
| `no_account` | A valid Clerk session with no matching membership. | Portal API, 403 |
| `not_found` | The resource doesn't exist, or belongs to another client. | Portal API, 404; unknown route, 404 |
| `invoice_not_payable` | The invoice's status is not `open`. | `POST /api/invoices/:id/checkout`, 409 |
| `payment_in_progress` | Another checkout for this invoice already holds the claim on it. | `POST /api/invoices/:id/checkout`, 409 |
| `payments_not_configured` | `STRIPE_SECRET_KEY` is unset. | `POST /api/invoices/:id/checkout`, 503 |
| `payments_unavailable` | The Stripe API call failed (rate limit, network, rejected amount). | `POST /api/invoices/:id/checkout`, 503 |
| `too_many_attempts` | Checkout attempt throttle exceeded for this member. | `POST /api/invoices/:id/checkout`, 429 |
| `invalid_signature` | The Stripe webhook signature failed verification, or is missing. | `POST /api/stripe/webhook`, 400 |
| `payload_too_large` | Webhook body exceeds 64 KiB. | `POST /api/stripe/webhook`, 413 |

## Portal API (`portal.mnlith.dev`, `localhost` in dev)

Every route below requires `Authorization: Bearer <Clerk session JWT>` except
`GET /api/public-config` and `GET /healthz`. The Worker verifies the session with
`@clerk/backend`, resolves the caller's membership (binding it to the Clerk user id on first
login), and scopes every query by that membership's `client_id`. A resource belonging to a
different client answers `404 not_found`, never `403` — the response never confirms that a
resource exists for someone else. A `draft` invoice has not been issued to the client, so it is
invisible on every portal route: never listed, `404` on detail and on checkout.

Every `/api/*` response carries `Cache-Control: no-store`, including the `401` and `403` ones. The
portal's static assets keep their own caching headers.

### `GET /api/public-config`

Public. No auth.

```json
{ "clerkPublishableKey": "pk_test_..." }
```

### `GET /api/me`

```json
{
  "user": { "id": "user_..." },
  "membership": { "id": "...", "role": "owner" | "member", "status": "invited" | "active" | "revoked" },
  "client": { "id": "...", "name": "...", "billingEmail": "..." },
  "balanceCents": 42500
}
```

`balanceCents` is the sum of `total_cents` for the client's `open` and `processing` invoices.

### `GET /api/clients/:id`

Own client only; any other id is `404 not_found`.

```json
{ "id": "...", "name": "...", "billingEmail": "..." }
```

### `GET /api/services`

```json
{
  "services": [
    { "id": "...", "name": "...", "description": "...", "status": "active" | "ended", "startedAt": 1234567890, "endedAt": null }
  ]
}
```

### `GET /api/invoices[?status=open|processing|paid|void]`

Never includes `draft` invoices, whatever `status` asks for.

```json
{
  "invoices": [
    {
      "id": "...", "number": "MON-00001", "status": "open", "totalCents": 42500, "currency": "usd",
      "description": "...", "issuedAt": 1234567890, "dueAt": 1234567890, "paidAt": null
    }
  ]
}
```

### `GET /api/invoices/:id`

`404 not_found` if the invoice doesn't exist or isn't the caller's.

```json
{
  "id": "...", "number": "MON-00001", "status": "open", "totalCents": 42500, "currency": "usd",
  "description": "...", "issuedAt": 1234567890, "dueAt": 1234567890, "paidAt": null,
  "items": [
    { "id": "...", "description": "...", "quantity": 1, "unitCents": 27500, "amountCents": 27500 }
  ],
  "payments": [
    { "id": "...", "status": "succeeded", "amountCents": 42500, "method": null, "createdAt": 1234567890, "succeededAt": 1234567890 }
  ]
}
```

`method` is best-effort in Phase 1 and is usually `null`: with Stripe's automatic payment methods a
Checkout Session lists every method enabled on the account, so it is only recorded when the session
offered exactly one (`"card"`, `"us_bank_account"`). A later phase reads the real value from the
PaymentIntent.

### `POST /api/invoices/:id/checkout`

Starts (or reuses a pending, unexpired) Stripe Checkout Session for the invoice.

A pending session is reused only when it was created by this same channel (`source = 'portal'`); a
pending pay-host session for the invoice is expired at Stripe and marked `canceled` first. Before
calling Stripe, the invoice is claimed with a database insert enforcing at most one open payment
row per invoice, so a request that loses that race either waits for the winner's session url or, if
the claim it held is lost after Stripe already answered, reports `payment_in_progress`.

- `201 { "url": "https://checkout.stripe.com/..." }`
- `404 { "error": "not_found" }` — not the caller's invoice, or a `draft`
- `409 { "error": "invoice_not_payable" }` — invoice status is not `open`
- `409 { "error": "payment_in_progress" }` — another checkout for this invoice is already in flight
- `429 { "error": "too_many_attempts", "retryAfterSeconds": 600 }` — more than 10 checkout POSTs
  from this member within the last 10 minutes; a `Retry-After` header carries the same value
- `503 { "error": "payments_not_configured" }` — `STRIPE_SECRET_KEY` is unset
- `503 { "error": "payments_unavailable" }` — the Stripe call failed

Checkout POSTs are throttled per member (10 per rolling 10-minute window; see "Checkout abuse
throttle" below). Only this route counts; every `GET` route is unthrottled.

### `GET /healthz`

Both hosts. `{ "status": "ok" }`, no auth.

## Pay host routes (`pay.mnlith.dev`, `pay.localhost` in dev)

Server-rendered HTML, no client-side JavaScript, no Clerk. The `/i/:token` routes resolve the
invoice by the payment-link token's SHA-256 hash; a malformed, unknown, revoked, `draft`-invoice or
void-invoice token is a generic `404` HTML page in every case below.

| Route | Behavior |
|---|---|
| `GET /i/:token` | Renders the invoice (number, description, line items, amount due, a Pay form) for an `open` invoice; a distinct "already paid" page for `paid`; the generic 404 otherwise. |
| `GET /i/:token` (invoice `processing`) | A distinct "payment processing" page for a settling ACH debit: number and status only, no line items, no amount, no Pay form. |
| `POST /i/:token/checkout` | Creates (or reuses) a Stripe Checkout Session and `303`-redirects to it. If the invoice isn't payable, `303`s back to `/i/:token` instead of creating a session. If another checkout already holds the invoice's claim, renders a branded `409` "payment already in progress" page. If Stripe isn't configured or the Stripe call fails, renders the 503 "payments are not available right now" page. Throttled per payment link (10 POSTs per rolling 10-minute window): over the limit renders a branded `429` "too many payment attempts" page with a `Retry-After` header; page views (`GET /i/:token`) never count. |
| `GET /checkout/complete?session_id=cs_...` | Post-Checkout landing page; message depends on the invoice's current status (paid — with number, amount and paid date / processing / still confirming). |
| `GET /checkout/cancel?session_id=cs_...` | Shown when the payer cancels out of Stripe Checkout. |
| `GET /pay.css`, `GET /favicon.svg` | Static assets for the pay page (not user data). |
| `GET /healthz` | `{ "status": "ok" }`. |

The two return routes are the `success_url` and `cancel_url` handed to Stripe, built from the
origin the request arrived on (so a dev port survives the round trip) with Stripe's literal
`{CHECKOUT_SESSION_ID}` placeholder. **No payment-link token is ever put in a url given to Stripe**,
and neither page contains a token or a link to one. The `session_id` must match
`^cs_(test|live)_[A-Za-z0-9]{8,}$` and must belong to a payment-link checkout of this database;
anything else is the generic 404 before any lookup happens.

Every pay-host response carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex, nofollow` (the HTML also carries `<meta name="robots" content="noindex,
nofollow">`), and the CSP
`default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'`.
A request for an unrecognized hostname gets that same header set with its generic 404.

## Checkout abuse throttle

Both checkout-creation routes (`POST /i/:token/checkout` on the pay host, `POST
/api/invoices/:id/checkout` on the portal) are throttled: at most 10 POSTs per rolling 10-minute
window, per key (`app/src/domain/throttle.ts`), counted with one atomic D1 UPSERT (the same
insert-or-update-with-window-reset pattern the inquiry API's rate limiter uses, `api/src/index.ts`).
The key is the payment link (`link:<payment_link_id>`) on the pay host and the member
(`member:<membership_id>`) on the portal, so one abused link or member never throttles any other.
Only a POST that reaches the checkout route counts; `GET` page views never do. There is
deliberately **no CAPTCHA**: a payment-link token is 32 cryptographically random bytes (see "Token
design" in `app/README.md`), which already makes it infeasible to brute force, so this throttle
only has to slow down repeated attempts against an already-known link or a signed-in member's own
checkout endpoint.

## Webhook contract

### `POST /api/stripe/webhook` (pay host)

Authenticated only by the Stripe signature (`stripe-signature` header) — there is no session or
API key on this route. Body is capped at 64 KiB (`413 payload_too_large` above that): `Content-Length`
is checked first, then the body is read as a stream and abandoned as soon as it passes the cap, so an
oversized chunked body is never buffered whole.

1. Verify the signature with `constructEventAsync` + `createSubtleCryptoProvider()`
   (`STRIPE_WEBHOOK_SECRET`). Failure or a missing header: `400 { "error": "invalid_signature" }`.
2. If the event's `livemode` doesn't match `STRIPE_MODE`, or the event type isn't one of the four
   handled types, it is recorded with outcome `ignored` and answered `200`. A refund, dispute or
   `payment_intent.*` event is linked to the `payments` row whose `stripe_payment_intent_id` it
   names (`data.object.payment_intent`, or `data.object.id` for `payment_intent.*`), so the history
   can be joined to the payment; it still changes no state in Phase 1.
3. Otherwise the event, plus every state change it causes, is written in one atomic
   `db.batch()` alongside an insert into `payment_events` (`stripe_event_id` is `UNIQUE`). If that
   insert collides — the event was already processed — nothing is re-applied and the response is
   still `200` (idempotent replay).
4. The Checkout Session's amount and currency are verified against the stored `payments` row, never
   trusted from the event; a mismatch is recorded (`outcome: "mismatch"`) and never marks an
   invoice paid. An event for a session this database has no record of is recorded as
   `unmatched`.
5. `payload_json` stores the event with `data.object.success_url`, `data.object.cancel_url` and
   `data.object.url` removed. They are the Worker's own urls, and historically carried a
   payment-link token; the in-memory event is never modified.
6. Every invoice transition is conditional on the payment row's state *after* this batch's payment
   update, so out-of-order delivery cannot strand an invoice: a late `completed` cannot move an
   invoice whose payment already failed, and `invoice.paid` is audited only when the invoice update
   actually fired.

Handled event types: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`. Refund and dispute events
(`charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`) are recorded for history only.

Response: `200 { "received": true, "outcome": "applied" | "ignored" | "unmatched" | "mismatch" | "duplicate" }`.

## Reserved: MONOLITH internal-app contract (not implemented in Phase 1)

A future staff/admin API for the MONOLITH internal app (a separate, server-side Next.js
application outside this repo) to manage clients, invoices and payment links in `monolith-app`
directly — a boundary, not a Phase 1 feature. `app/migrations/0001_app.sql` reserves the
`staff_api_keys` table; no Phase 1 code reads or writes it, and none of the endpoints below exist
yet.

**Auth**: `Authorization: Bearer mk_<secret>`, accepted only on `admin.mnlith.dev`. No portal
session, no cookie.

**Credential rules**:

- The secret is a random value of at least 32 bytes; only its hash is ever stored, in
  `staff_api_keys.key_hash`.
- Each key carries `scopes_json`, so a key can be limited to what its holder actually needs.
- Keys are revocable (`staff_api_keys.revoked_at`) and rate-limited per key.
- The credential is used **server-side only** — MONOLITH's server holds it, never a browser.
- Production hardening: a Cloudflare Access service token in front of `admin.mnlith.dev`, so a
  leaked `mk_` secret alone still isn't enough to reach the route.

**Intended endpoints** (shapes to be finalized when this is implemented):

```
POST /admin/clients
POST /admin/clients/:id/memberships
POST /admin/invoices
POST /admin/invoices/:id/open
POST /admin/invoices/:id/payment-link
POST /admin/invoices/:id/void
```
