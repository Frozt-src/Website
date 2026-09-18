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
| `payments_not_configured` | `STRIPE_SECRET_KEY` is unset. | `POST /api/invoices/:id/checkout`, 503 |
| `invalid_signature` | The Stripe webhook signature failed verification, or is missing. | `POST /api/stripe/webhook`, 400 |
| `payload_too_large` | Webhook body exceeds 64 KiB. | `POST /api/stripe/webhook`, 413 |

## Portal API (`portal.mnlith.dev`, `localhost` in dev)

Every route below requires `Authorization: Bearer <Clerk session JWT>` except
`GET /api/public-config` and `GET /healthz`. The Worker verifies the session with
`@clerk/backend`, resolves the caller's membership (binding it to the Clerk user id on first
login), and scopes every query by that membership's `client_id`. A resource belonging to a
different client answers `404 not_found`, never `403` — the response never confirms that a
resource exists for someone else.

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

### `GET /api/invoices[?status=draft|open|processing|paid|void]`

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
    { "id": "...", "status": "succeeded", "amountCents": 42500, "method": "card", "createdAt": 1234567890, "succeededAt": 1234567890 }
  ]
}
```

### `POST /api/invoices/:id/checkout`

Starts (or reuses a pending, unexpired) Stripe Checkout Session for the invoice.

- `201 { "url": "https://checkout.stripe.com/..." }`
- `404 { "error": "not_found" }` — not the caller's invoice
- `409 { "error": "invoice_not_payable" }` — invoice status is not `open`
- `503 { "error": "payments_not_configured" }` — `STRIPE_SECRET_KEY` is unset

### `GET /healthz`

Both hosts. `{ "status": "ok" }`, no auth.

## Pay host routes (`pay.mnlith.dev`, `pay.localhost` in dev)

Server-rendered HTML, no client-side JavaScript, no Clerk. Every route resolves the invoice by
the payment-link token's SHA-256 hash; a malformed, unknown, revoked, or void-invoice token is a
generic `404` HTML page in every case below.

| Route | Behavior |
|---|---|
| `GET /i/:token` | Renders the invoice (number, description, line items, amount due, a Pay form) for an `open` or `processing` invoice; a distinct "already paid" page for `paid`; the generic 404 otherwise. |
| `POST /i/:token/checkout` | Creates (or reuses) a Stripe Checkout Session and `303`-redirects to it. If the invoice isn't payable, `303`s back to `/i/:token` instead of creating a session. If Stripe isn't configured, renders the 503 "payments are not available right now" page. |
| `GET /i/:token/complete` | Post-Checkout landing page; message depends on the invoice's current status (paid / processing / still confirming). |
| `GET /i/:token/cancel` | Shown when the payer cancels out of Stripe Checkout. |
| `GET /pay.css`, `GET /favicon.svg` | Static assets for the pay page (not user data). |
| `GET /healthz` | `{ "status": "ok" }`. |

CSP on every pay-host response:
`default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'`.

## Webhook contract

### `POST /api/stripe/webhook` (pay host)

Authenticated only by the Stripe signature (`stripe-signature` header) — there is no session or
API key on this route. Body is capped at 64 KiB (`413 payload_too_large` above that, checked by
`Content-Length` first, then by the actual decoded size).

1. Verify the signature with `constructEventAsync` + `createSubtleCryptoProvider()`
   (`STRIPE_WEBHOOK_SECRET`). Failure or a missing header: `400 { "error": "invalid_signature" }`.
2. If the event's `livemode` doesn't match `STRIPE_MODE`, or the event type isn't one of the four
   handled types, it is recorded with outcome `ignored` and answered `200`.
3. Otherwise the event, plus every state change it causes, is written in one atomic
   `db.batch()` alongside an insert into `payment_events` (`stripe_event_id` is `UNIQUE`). If that
   insert collides — the event was already processed — nothing is re-applied and the response is
   still `200` (idempotent replay).
4. The Checkout Session's amount and currency are verified against the stored `payments` row, never
   trusted from the event; a mismatch is recorded (`outcome: "mismatch"`) and never marks an
   invoice paid. An event for a session this database has no record of is recorded as
   `unmatched`.

Handled event types: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`.

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
