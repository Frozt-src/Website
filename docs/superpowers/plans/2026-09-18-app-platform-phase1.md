# Monolith Application Platform Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `app/` foundation: D1 schema, domain layer, Clerk-backed portal auth with membership binding, opaque payment links, server-rendered pay page, Stripe test-mode Checkout + idempotent webhooks, a minimal portal SPA, tests, seed tooling and docs — all runnable offline and never touching production.

**Architecture:** One new Worker `monolith-app` (`app/wrangler.jsonc`, Hono) routes by hostname: pay host = server-rendered HTML + webhook; portal host = SPA static assets + `/api/*`. `createApp(deps)` takes injectable dependencies (db, clock, random, session verifier, Clerk users, Stripe gateway, webhook verifier) so tests run against real SQLite with fakes for Clerk/Stripe. New D1 `monolith-app`; inquiry Worker/DB untouched.

**Tech Stack:** Hono 4.13.8, stripe 22.6.2, @clerk/backend 3.18.1, @clerk/clerk-react 5.61.3, React 19, Vite 8, TypeScript 7, wrangler 4.133, Node 24 `node:test` + `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-18-app-platform-phase1-design.md`

## Global Constraints

- Branch `app-platform-phase1` in `Z:\Projekts\MNLTH WEBAPP\Website`. Commit after each task. Never push, never deploy (`wrangler deploy` only with `--dry-run`), never run `wrangler login`, never touch remote D1, never change Cloudflare/GitHub/Stripe/Clerk settings, never create cloud resources.
- **No external PSA/CRM vendor integration is in scope: no code, comments, docs, imports, env vars or references to any external PSA/CRM vendor anywhere in this work.**
- Do not modify `api/`, `src/`, `index.html`, `privacy.html`, `404.html`, root `wrangler.jsonc`, `vite.config.ts`, `scripts/verify-site.mjs` (the live site and inquiry API). Root `package.json`, root `.gitignore`, root `README.md` may be edited only as this plan states.
- No secrets in git. Local secrets only in `app/.dev.vars` (git-ignored). `app/.dev.vars.example` holds placeholders only (`sk_test_replace_me` style). Never put live keys anywhere.
- Runtime deps exactly pinned: `hono@4.13.8`, `stripe@22.6.2`, `@clerk/backend@3.18.1`, `@clerk/clerk-react@5.61.3`. No other new dependencies.
- Every portal API query is scoped by the caller's `client_id`; other clients' resources return 404. Never query an invoice or payment by id alone in portal code.
- Money: integer cents, currency `usd`. Timestamps: Unix seconds (INTEGER). IDs: `crypto.randomUUID()` text.
- Invoice status values exactly: `draft`, `open`, `processing`, `paid`, `void`. Payment status: `pending`, `processing`, `succeeded`, `failed`, `canceled`. Membership status: `invited`, `active`, `revoked`. Link status: `active`, `revoked`.
- Pay host CSP exactly: `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'`.
- Plaintext payment tokens are never logged, never stored, never put in audit rows.
- Tests: `node --test`, real SQLite via `node:sqlite` running the real migration files, fakes injected through `createApp(deps)`. `npm test` and `npm run typecheck` must pass at the end of every task.
- Code style: TypeScript, 2-space indent, single quotes, semicolons (match `api/src/index.ts`); small focused modules; no speculative features.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (or the model's own attribution line from its harness).

---

### Task 1: Worker scaffold, hostname routing, migration 0001, test harness

**Files:**
- Modify: `package.json` (scripts + dependencies), `.gitignore` (one line)
- Create: `app/wrangler.jsonc`, `app/tsconfig.json`, `app/.dev.vars.example`, `app/migrations/0001_app.sql`
- Create: `app/src/deps.ts`, `app/src/app.ts`, `app/src/index.ts`, `app/src/http/headers.ts`
- Create: `app/tests/helpers/d1.ts`, `app/tests/helpers/app.ts`, `app/tests/routing.test.ts`, `app/tests/migrations.test.ts`

**Interfaces:**
- Produces: `createApp(deps: AppDeps): { fetch(request: Request): Promise<Response> }` in `app/src/app.ts`; `AppDeps` in `app/src/deps.ts`; test helpers `database()` and `testDeps(overrides)`; migration `0001_app.sql`.

- [ ] **Step 1: Dependencies and scripts** (`package.json`)

Add to `dependencies` (exact versions): `"@clerk/backend": "3.18.1"`, `"@clerk/clerk-react": "5.61.3"`, `"hono": "4.13.8"`, `"stripe": "22.6.2"`. Run `npm install --no-audit --no-fund` (updates `package-lock.json`).

Replace scripts `typecheck`, `test`, `test:watch` and add `app:*`:

```json
    "typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p api/tsconfig.json && tsc --noEmit -p app/tsconfig.json",
    "test": "node --test api/tests/*.test.ts app/tests/*.test.ts",
    "test:watch": "node --test --watch api/tests/*.test.ts app/tests/*.test.ts",
    "app:dev": "wrangler dev --config app/wrangler.jsonc --env dev --port 8788",
    "app:migrate:local": "wrangler d1 migrations apply monolith-app --local --config app/wrangler.jsonc --env dev",
    "app:check": "npm run typecheck && wrangler deploy --dry-run --config app/wrangler.jsonc"
```

(Task 7 extends `typecheck`/`app:check` with the portal build.) In `.gitignore`, after the line `.dev.vars.*` add `!.dev.vars.example`.

- [ ] **Step 2: `app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: `app/wrangler.jsonc`**

```jsonc
{
  "$schema": "../node_modules/wrangler/config-schema.json",
  "name": "monolith-app",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-17",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "assets": {
    "directory": "./dist/portal",
    "binding": "ASSETS",
    "run_worker_first": true,
    "not_found_handling": "single-page-application"
  },
  "vars": {
    "PAY_HOST": "pay.mnlith.dev",
    "PORTAL_HOST": "portal.mnlith.dev",
    "ADMIN_HOST": "admin.mnlith.dev",
    "STRIPE_MODE": "test",
    "CLERK_PUBLISHABLE_KEY": "",
    "CLERK_FRONTEND_API_URL": ""
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "monolith-app",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }],
  "observability": { "enabled": true, "logs": { "invocation_logs": false }, "traces": { "enabled": false } },
  "env": {
    "dev": {
      "vars": {
        "PAY_HOST": "pay.localhost",
        "PORTAL_HOST": "localhost",
        "ADMIN_HOST": "admin.localhost",
        "STRIPE_MODE": "test",
        "CLERK_PUBLISHABLE_KEY": "",
        "CLERK_FRONTEND_API_URL": ""
      },
      "d1_databases": [{
        "binding": "DB",
        "database_name": "monolith-app",
        "database_id": "00000000-0000-0000-0000-000000000000",
        "migrations_dir": "migrations"
      }]
    }
  }
}
```

No `routes`: Custom Domains are added at production activation by the owner. The placeholder `database_id` is replaced when the owner runs `wrangler d1 create monolith-app`. `app/dist/` is git-ignored (root `dist/` pattern); the dry run in Step 10 creates a placeholder `app/dist/portal/index.html` first.

- [ ] **Step 4: `app/.dev.vars.example`**

```
# Copy to app/.dev.vars (git-ignored). Test-mode / development keys only. Never live keys.
CLERK_SECRET_KEY=sk_test_replace_me
CLERK_JWT_KEY=
STRIPE_SECRET_KEY=sk_test_replace_me
STRIPE_WEBHOOK_SECRET=whsec_replace_me
```

- [ ] **Step 5: Migration `app/migrations/0001_app.sql`** (exact)

```sql
-- Monolith application database: clients, memberships, services, invoices, payments.
-- Timestamps are Unix seconds. Money is integer cents. IDs are UUID text.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  stripe_customer_id TEXT UNIQUE,
  external_source TEXT,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX clients_external ON clients(external_source, external_id) WHERE external_source IS NOT NULL;

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  email TEXT NOT NULL,
  clerk_user_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  bound_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX memberships_client_email ON memberships(client_id, email);
CREATE UNIQUE INDEX memberships_client_user ON memberships(client_id, clerk_user_id) WHERE clerk_user_id IS NOT NULL;
CREATE INDEX memberships_user ON memberships(clerk_user_id);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_client ON services(client_id, status);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'processing', 'paid', 'void')),
  currency TEXT NOT NULL DEFAULT 'usd',
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  description TEXT NOT NULL,
  issued_at INTEGER,
  due_at INTEGER,
  paid_at INTEGER,
  voided_at INTEGER,
  external_source TEXT,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX invoices_client_status ON invoices(client_id, status);
CREATE UNIQUE INDEX invoices_external ON invoices(external_source, external_id) WHERE external_source IS NOT NULL;

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents INTEGER NOT NULL CHECK (unit_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents = quantity * unit_cents)
);
CREATE UNIQUE INDEX invoice_items_position ON invoice_items(invoice_id, position);

CREATE TABLE payment_links (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE UNIQUE INDEX payment_links_one_active ON payment_links(invoice_id) WHERE status = 'active';

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  payment_link_id TEXT REFERENCES payment_links(id),
  source TEXT NOT NULL CHECK (source IN ('payment_link', 'portal')),
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  method TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  session_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  failed_at INTEGER
);
CREATE INDEX payments_invoice ON payments(invoice_id, status);

CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  stripe_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  invoice_id TEXT REFERENCES invoices(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored', 'unmatched', 'mismatch')),
  payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX payment_events_payment ON payment_events(payment_id);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'client_user', 'staff', 'stripe')),
  actor_id TEXT,
  client_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT
);
CREATE INDEX audit_events_client_time ON audit_events(client_id, occurred_at);

-- Reserved for the future staff/admin API (MONOLITH internal app). No Phase 1 code uses it.
CREATE TABLE staff_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
```

- [ ] **Step 6: Dependencies contract `app/src/deps.ts`** (exact)

```ts
// Everything the Worker needs from the outside world, so tests can inject fakes.
export interface Hosts { pay: string; portal: string; admin: string }

export interface SessionVerifier {
  // Resolves the Clerk user id for a valid session JWT, or null when invalid/expired.
  verify(token: string): Promise<{ userId: string } | null>;
}
export interface ClerkUsers {
  // Primary email address if it is verified, else null. Only used at first login.
  primaryVerifiedEmail(userId: string): Promise<string | null>;
}
export interface CheckoutSessionInput {
  idempotencyKey: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  description: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number; // unix seconds
}
export interface StripeGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }>;
}
export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}
export interface WebhookVerifier {
  // Throws on an invalid signature.
  verify(payload: string, signatureHeader: string): Promise<StripeEvent>;
}

export interface AppDeps {
  db: D1Database;
  assets?: { fetch(request: Request): Promise<Response> };
  hosts: Hosts;
  stripeMode: 'test' | 'live';
  clerkPublishableKey: string;
  clerkFrontendApiUrl: string;
  sessions: SessionVerifier;
  clerkUsers: ClerkUsers;
  stripe: StripeGateway;
  webhooks: WebhookVerifier;
  now(): number; // unix seconds
  randomBytes(length: number): Uint8Array;
  logError(event: string, error: unknown): void; // never logs personal data or tokens
}
```

- [ ] **Step 7: App factory, headers, host routing** (`app/src/app.ts`, `app/src/http/headers.ts`, `app/src/index.ts`)

`headers.ts` exports two functions returning `Record<string,string>`: `payHeaders()` = the exact pay CSP from Global Constraints plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Frame-Options: DENY`; `portalHeaders(clerkFrontendApiUrl)` = CSP `default-src 'self'; script-src 'self' <fapi>; connect-src 'self' <fapi>; img-src 'self' https://img.clerk.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` (when `clerkFrontendApiUrl` is empty, omit it and `frame-src`), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` on both. (The `style-src 'unsafe-inline'` allowance is a Clerk requirement for the portal host only.)

`app.ts`: `createApp(deps)` builds two Hono apps, `pay` and `portal` (Task 5/6 add their routes; this task adds `GET /healthz` → `{status:'ok'}` on both and `GET /api/public-config` → `{clerkPublishableKey}` on portal). Each app has a middleware that applies its header set to every response (including 404s). The returned `fetch(request)` picks the app by `new URL(request.url).hostname` compared to `deps.hosts.pay` / `deps.hosts.portal` (exact, case-insensitive); the admin host and any other host return `404 {error:'not_found'}` with `Cache-Control: no-store`. On the portal host, requests not starting with `/api/` are served by `deps.assets.fetch(request)` when `assets` is present, else 404. `index.ts` exports `default { fetch(request, env, ctx) }` that maps `env` to `AppDeps` with production implementations; for this task use placeholder implementations that throw `Error('not configured')` for `sessions`, `clerkUsers`, `stripe`, `webhooks` (Tasks 3/4 replace them). `randomBytes` = `crypto.getRandomValues`, `now` = `Math.floor(Date.now()/1000)`, `logError` = `console.error(JSON.stringify({event, error: error instanceof Error ? error.name : 'unknown'}))`.

- [ ] **Step 8: Test helpers**

`app/tests/helpers/d1.ts`: build an in-memory `node:sqlite` `DatabaseSync`, run every `app/migrations/*.sql` in filename order, and return `{ sql, db }` where `db` implements the D1 surface used by the app: `prepare(query)` → object with `bind(...values)`, `first<T>()`, `first<T>(column)`, `all<T>()` returning `{results}`, `run()` returning `{success, meta:{changes, last_row_id}}`; `batch(statements)` runs all inside `BEGIN`/`COMMIT` with `ROLLBACK` on any error and rethrows; `exec(sql)`. Keep foreign keys on (`PRAGMA foreign_keys = ON`).

`app/tests/helpers/app.ts`: `testDeps(overrides = {})` returns `AppDeps` with: the SQLite db, `hosts: {pay:'pay.test', portal:'portal.test', admin:'admin.test'}`, `stripeMode:'test'`, `clerkPublishableKey:'pk_test_fake'`, `clerkFrontendApiUrl:'https://fake.clerk.accounts.dev'`, a `FakeSessions` (map token→userId), `FakeClerkUsers` (map userId→email|null, counts calls), `FakeStripe` (records inputs, returns `{id:'cs_test_'+n, url:'https://checkout.stripe.com/c/pay/cs_test_'+n}`), `FakeWebhooks` (returns the event object passed as JSON payload; throws when signature header !== 'valid'), a controllable clock `now()`, deterministic `randomBytes` (counter-seeded), `logError` collecting to an array. Also export `payUrl(path)` = `https://pay.test${path}` and `portalUrl(path)`.

- [ ] **Step 9: Tests** (`app/tests/routing.test.ts`, `app/tests/migrations.test.ts`)

routing: unknown host → 404 JSON; `GET https://pay.test/healthz` → 200 `{status:'ok'}` with the exact pay CSP header and `Cache-Control: no-store`; `GET https://portal.test/healthz` → 200 with a CSP containing `script-src 'self' https://fake.clerk.accounts.dev` and HSTS; `GET https://portal.test/api/public-config` → `{clerkPublishableKey:'pk_test_fake'}`; `GET https://portal.test/anything` with a fake `assets` → the assets response; `GET https://pay.test/index.html` → 404 (assets never served on the pay host); `GET https://admin.test/healthz` → 404.

migrations: after helper setup, `sqlite_master` lists all 10 tables; `PRAGMA foreign_keys` = 1; inserting an invoice with `status = 'bogus'` throws; inserting a second `payment_links` row with `status='active'` for the same invoice throws; inserting `invoice_items` with `amount_cents != quantity*unit_cents` throws; inserting a payment with an unknown `invoice_id` throws (FK).

- [ ] **Step 10: Verify and commit**

```bash
npm test && npm run typecheck
mkdir -p app/dist/portal && echo '<!doctype html><title>placeholder</title>' > app/dist/portal/index.html && npx wrangler deploy --dry-run --config app/wrangler.jsonc && npx wrangler deploy --dry-run --config app/wrangler.jsonc --env dev
```
Expected: all tests pass (23 existing + new), typecheck clean, both dry runs exit 0 listing the D1 binding and assets. Then:

```bash
git add package.json package-lock.json .gitignore app
git commit -m "Scaffold monolith-app Worker: hostname routing, schema migration, test harness"
```
(add the Co-Authored-By trailer line to every commit message body)

---

### Task 2: Domain layer: models, money, tokens, invoices, payment links, audit

**Files:**
- Create: `app/src/domain/models.ts`, `app/src/domain/ids.ts`, `app/src/domain/money.ts`, `app/src/domain/tokens.ts`, `app/src/domain/audit.ts`, `app/src/domain/clients.ts`, `app/src/domain/invoices.ts`, `app/src/domain/payment-links.ts`
- Create: `app/tests/helpers/fixtures.ts`, `app/tests/domain.test.ts`

**Interfaces:**
- Consumes: `AppDeps` (db, now, randomBytes), migration 0001.
- Produces (exact signatures; later tasks import these):
  - `models.ts`: TS types `Client`, `Membership`, `Service`, `Invoice`, `InvoiceItem`, `PaymentLink`, `Payment`, `PaymentEvent`, `AuditEvent` mirroring the columns (camelCase fields), plus `InvoiceStatus`, `PaymentStatus` unions.
  - `ids.ts`: `newId(): string` (`crypto.randomUUID()`).
  - `money.ts`: `formatUsd(cents: number): string` → `$425.00` (thousands separators, always 2 decimals).
  - `tokens.ts`: `generateToken(randomBytes): string` (32 bytes → base64url, no padding, 43 chars); `isWellFormedToken(s: string): boolean` (`/^[A-Za-z0-9_-]{43}$/`); `hashToken(token: string): Promise<string>` (SHA-256 hex via `crypto.subtle`).
  - `audit.ts`: `recordAudit(db, event: Omit<AuditEvent,'id'>): Promise<void>` and `auditStatement(db, event): D1PreparedStatement` (for batches).
  - `clients.ts`: `getClient(db, clientId): Promise<Client|null>`; `listServices(db, clientId): Promise<Service[]>`.
  - `invoices.ts`: `nextInvoiceNumber(db): Promise<string>` (`MON-` + 5-digit zero-padded max+1, starting `MON-00001`); `createInvoice(db, now, input: {clientId, description, items: {description, quantity, unitCents}[], status?: 'draft'|'open', issuedAt?, dueAt?}): Promise<Invoice>` (total = sum of items; inserts items with positions 1..n in one `batch`); `getInvoiceForClient(db, clientId, invoiceId): Promise<Invoice|null>`; `listInvoicesForClient(db, clientId, status?): Promise<Invoice[]>` (newest first); `listInvoiceItems(db, invoiceId): Promise<InvoiceItem[]>`; `outstandingBalanceCents(db, clientId): Promise<number>` (sum of `total_cents` where status in `open`,`processing`).
  - `payment-links.ts`: `createPaymentLink(db, deps: {now, randomBytes}, invoiceId): Promise<{ link: PaymentLink; token: string }>` (revokes any existing active link for the invoice in the same batch, so the one-active index holds); `revokePaymentLink(db, now, linkId): Promise<void>`; `resolvePaymentLink(db, now, token): Promise<{ link: PaymentLink; invoice: Invoice; client: Client } | null>` — returns null when the token is malformed, unknown, revoked, or the invoice is `void` or `draft`; updates `last_used_at`. The caller decides what to show for `paid`.

- [ ] **Step 1: Write failing tests** (`app/tests/domain.test.ts`; use `fixtures.ts` helpers `seedClient(db, now, {name, billingEmail})`, `seedInvoice(...)` built on the domain functions)

Cases: `formatUsd(42500) === '$425.00'`, `formatUsd(123456789) === '$1,234,567.89'`, `formatUsd(0) === '$0.00'`; `generateToken` is 43 chars and well-formed, two calls differ; `hashToken` of a known string equals the known SHA-256 hex (compute the expected hex in the test with `node:crypto`); `nextInvoiceNumber` on empty DB is `MON-00001`, after creating MON-00001 and MON-00007 it is `MON-00008`; `createInvoice` stores total = sum(items), items positions 1..n; `getInvoiceForClient` with another client's id returns null; `listInvoicesForClient` filters by status; `outstandingBalanceCents` counts open + processing, not paid/void/draft; `createPaymentLink` then a second `createPaymentLink` leaves exactly one `active` link and the first resolves to null; `resolvePaymentLink` returns null for malformed (`'abc'`, 44 chars, `'+'` chars), unknown well-formed, revoked, void invoice, draft invoice; resolves for `open` and `paid`; `last_used_at` is set; audit rows are written for `payment_link.created` and `payment_link.revoked` with `details_json` that does **not** contain the token.

- [ ] **Step 2: Run tests, see them fail** (`node --test app/tests/domain.test.ts`)

- [ ] **Step 3: Implement** the modules per the Interfaces block. SQL is parameterized everywhere. `resolvePaymentLink` looks up by `token_hash` (unique index) — never scans and compares tokens.

- [ ] **Step 4: Run tests, see them pass; `npm test && npm run typecheck`**

- [ ] **Step 5: Commit** `git add app && git commit -m "Add app domain layer: invoices, payment links, tokens, audit"`

---

### Task 3: Clerk session auth, membership binding, `/api/me`, `/api/clients/:id`, `/api/services`

**Files:**
- Create: `app/src/auth/clerk.ts`, `app/src/auth/membership.ts`, `app/src/auth/middleware.ts`, `app/src/http/portal-api.ts`
- Modify: `app/src/app.ts` (mount portal API), `app/src/index.ts` (real Clerk deps)
- Create: `app/tests/auth.test.ts`

**Interfaces:**
- Consumes: `AppDeps.sessions`, `AppDeps.clerkUsers`, Task 2 domain.
- Produces: `requireClient` Hono middleware setting `c.var.auth = { userId, membership, client }`; `resolveMembership(db, deps, userId): Promise<{membership, client} | null>`; production `clerkSessionVerifier(env)` and `clerkUsersClient(env)` in `clerk.ts`.

- [ ] **Step 1: Failing tests** (`app/tests/auth.test.ts`)

Cases: no `Authorization` → 401 `{error:'unauthenticated'}`; `Bearer bad` (fake verifier returns null) → 401; valid token, user with no membership, Clerk email lookup returns `nobody@example.com` → 403 `{error:'no_account'}`; first login: membership row `invited` for `alex@example.com`, verifier maps token→`user_1`, fake Clerk users maps `user_1`→`alex@example.com` → `GET /api/me` 200 with `client.name`, `membership.status:'active'`, and the row now has `clerk_user_id='user_1'`, `bound_at` set, audit `membership.bound`; second request with the same token → 200 and the fake Clerk users call count is still 1 (no email lookup after binding); email comparison is case-insensitive (`Alex@Example.com`); unverified email (fake returns null) → 403 and row stays `invited`; membership `revoked` → 403; `GET /api/clients/<own id>` → 200; `GET /api/clients/<other client id>` → 404; `GET /api/services` lists only own client's services; `balanceCents` in `/api/me` equals `outstandingBalanceCents`.

- [ ] **Step 2: Run to see failures**

- [ ] **Step 3: Implement**

`membership.ts` `resolveMembership`: `SELECT ... FROM memberships m JOIN clients c ... WHERE m.clerk_user_id = ? AND m.status = 'active' ORDER BY m.created_at LIMIT 1`. If none: `email = await deps.clerkUsers.primaryVerifiedEmail(userId)`; if null → null. Else `UPDATE memberships SET clerk_user_id = ?, status = 'active', bound_at = ?, updated_at = ? WHERE lower(email) = lower(?) AND status = 'invited' AND clerk_user_id IS NULL` (one statement, then re-select; if `changes = 0` → null). Record audit `membership.bound` (actor `client_user`, actor_id = userId, entity `membership`). Bind at most one membership per login (first by created_at) — use a subquery selecting the id to update.

`middleware.ts` `requireClient`: parse `Authorization: Bearer <token>`; `deps.sessions.verify(token)`; on null → 401; `resolveMembership` → null → 403 `{error:'no_account'}`; set `c.set('auth', ...)`.

`portal-api.ts`: `GET /api/me` → `{ user:{id}, membership:{id, role, status}, client:{id, name, billingEmail}, balanceCents }`; `GET /api/clients/:id` → 404 unless `id === auth.client.id`; `GET /api/services`. Mount under the portal app in `app.ts` (all `/api/*` except `/api/public-config` go through `requireClient`).

`clerk.ts` (production): `clerkSessionVerifier({secretKey, jwtKey, authorizedParties})` uses `verifyToken` from `@clerk/backend` with `jwtKey` when set, else `secretKey` (check the installed type: it resolves to `{ data, errors }`; treat any `errors` or missing `data.sub` as invalid); returns `{userId: data.sub}` or null on any error (log via `logError('session_verify_failed')`, never the token). `clerkUsersClient({secretKey})` uses `createClerkClient({secretKey}).users.getUser(id)` and returns the primary email address only when its `verification.status === 'verified'`. `index.ts` wires them with `authorizedParties: ['https://' + env.PORTAL_HOST]` plus `http://localhost:8788` when `env.PORTAL_HOST === 'localhost'`.

- [ ] **Step 4: Run tests, then `npm test && npm run typecheck`**

- [ ] **Step 5: Commit** `git add app && git commit -m "Add Clerk session verification, membership binding and client-scoped portal API"`

---

### Task 4: Stripe gateway, checkout creation, idempotent webhook state machine

**Files:**
- Create: `app/src/stripe/gateway.ts`, `app/src/stripe/webhooks.ts`, `app/src/domain/payments.ts`, `app/src/http/webhook.ts`
- Modify: `app/src/app.ts` (mount `POST /api/stripe/webhook` on the pay host), `app/src/index.ts` (real Stripe deps)
- Create: `app/tests/payments.test.ts`, `app/tests/webhook-signature.test.ts`

**Interfaces:**
- Consumes: `StripeGateway`, `WebhookVerifier`, domain from Task 2.
- Produces:
  - `payments.ts`: `startCheckout(db, deps, input: { invoice: Invoice; client: Client; source: 'payment_link'|'portal'; paymentLinkId?: string; successUrl: string; cancelUrl: string }): Promise<{ url: string; payment: Payment }>`; `applyStripeEvent(db, deps, event: StripeEvent): Promise<{ outcome: 'applied'|'ignored'|'unmatched'|'mismatch'|'duplicate' }>`.
  - `gateway.ts`: `stripeGateway(secretKey): StripeGateway` (official SDK, `Stripe.createFetchHttpClient()`, `apiVersion` pinned to the SDK default, `idempotencyKey` request option).
  - `webhooks.ts`: `stripeWebhookVerifier(webhookSecret): WebhookVerifier` (`constructEventAsync` with `Stripe.createSubtleCryptoProvider()`).

- [ ] **Step 1: Failing tests**

`payments.test.ts` (fakes): `startCheckout` on an `open` invoice inserts a `payments` row (`pending`, `amount_cents` = invoice total, `session_expires_at` = now + 1800, `stripe_checkout_session_id` = fake id), passes `amountCents`, `currency`, `invoiceNumber`, `customerEmail`, `expiresAt`, `idempotencyKey === payment.id` to the gateway, and audits `checkout.created`; second `startCheckout` within the expiry window reuses the existing session (gateway called once, same url); after the clock passes `session_expires_at` a new session is created and the old payment is marked `canceled`; `startCheckout` on `processing`/`paid`/`void`/`draft` throws an error with `code: 'invoice_not_payable'`.

Webhook state machine via `applyStripeEvent` (build events with helper `checkoutEvent(type, {id: sessionId, payment_status, payment_intent, amount_total, currency, metadata})`):
- `checkout.session.completed` with `payment_status:'paid'` → payment `succeeded` (`stripe_payment_intent_id` set, `method:'card'` when `payment_method_types` includes only card, else null), invoice `paid` with `paid_at`; audit `invoice.paid`.
- replay of the same event id → `duplicate`, exactly one `payment_events` row, no second audit row, invoice unchanged.
- `completed` with `payment_status:'unpaid'` → payment `processing`, invoice `processing`.
- then `checkout.session.async_payment_succeeded` → `succeeded` / `paid`.
- `async_payment_failed` after processing → payment `failed` (`failed_at`), invoice back to `open`.
- `async_payment_succeeded` arriving before `completed` → invoice `paid`; the later `completed (unpaid)` does not regress it (conditional update, outcome `applied`, invoice still `paid`).
- `checkout.session.expired` → payment `canceled`, invoice unchanged.
- unknown session id → `unmatched`, event row stored, nothing else changes.
- `amount_total` ≠ payment amount → `mismatch`, invoice not paid, payment unchanged, audit `payment.amount_mismatch`.
- `livemode: true` with `stripeMode:'test'` → `ignored`.
- unrelated type (`charge.refunded`) → `ignored`, event row stored.
- a second session completing after the invoice is already `paid` → payment `succeeded`, invoice unchanged, audit `payment.duplicate_suspected`.
- HTTP: `POST https://pay.test/api/stripe/webhook` with header `stripe-signature: valid` → 200 `{received:true, outcome}`; with `stripe-signature: nope` → 400; missing header → 400; body over 64 KiB → 413; `POST https://portal.test/api/stripe/webhook` → 404.

`webhook-signature.test.ts` (real verifier, no network): use `new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({payload, secret})` to sign a JSON payload, then `stripeWebhookVerifier(secret).verify(payload, header)` returns the event; a wrong secret throws; a tampered payload throws; a timestamp older than 5 minutes throws (generate with `timestamp` far in the past).

- [ ] **Step 2: Run to see failures**

- [ ] **Step 3: Implement**

`applyStripeEvent`: (1) if `event.livemode !== (deps.stripeMode === 'live')` → insert event row `ignored`, return. (2) Only `checkout.session.*` types are handled; others → `ignored`. (3) Read `session.id`; load payment by `stripe_checkout_session_id` (join invoice); none → `unmatched`. (4) Compute the transition from the table above; amount/currency check against the payment row → `mismatch`. (5) Build one `db.batch([...])` containing: `INSERT INTO payment_events` (UNIQUE on `stripe_event_id`), conditional `UPDATE payments ... WHERE id = ? AND status IN (...)`, conditional `UPDATE invoices ... WHERE id = ? AND status IN (...)`, audit inserts. A UNIQUE-constraint failure on the event insert means the batch rolled back → return `duplicate`. Never throw for business outcomes; throw only on unexpected DB errors (the route returns 500 so Stripe retries). Store `payload_json` = `JSON.stringify(event)`.

`http/webhook.ts`: read raw body text (cap 64 KiB via `Content-Length` and by reading), require `stripe-signature`, `deps.webhooks.verify(payload, sig)` → on throw 400 `{error:'invalid_signature'}` (log `webhook_signature_failed`); then `applyStripeEvent`; respond 200 `{received:true, outcome}`.

Not-configured guard: `index.ts` builds the gateway only when `env.STRIPE_SECRET_KEY` is a non-empty string; otherwise it injects a gateway whose `createCheckoutSession` throws an `Error` with `code: 'stripe_not_configured'` (and `webhooks.verify` throws when `STRIPE_WEBHOOK_SECRET` is missing, so the route answers 400). `startCheckout` lets that error propagate; Task 5 maps it to a 503 page and Task 6 to `503 {error:'payments_not_configured'}`.

`gateway.ts`: `stripe.checkout.sessions.create({ mode:'payment', client_reference_id: invoiceId, customer_email, line_items:[{ quantity:1, price_data:{ currency, unit_amount: amountCents, product_data:{ name:`Invoice ${invoiceNumber}`, description } } }], metadata:{ invoice_id, invoice_number, payment_id }, success_url, cancel_url, expires_at }, { idempotencyKey })`; return `{id, url}` (throw if `url` is null).

- [ ] **Step 4: Run tests, `npm test && npm run typecheck`, and `npm run app:check`** (dry run must still pass with the SDKs bundled)

- [ ] **Step 5: Commit** `git add app && git commit -m "Add Stripe checkout creation and idempotent webhook state machine"`

---

### Task 5: Pay host: server-rendered invoice page, checkout POST, completion pages

**Files:**
- Create: `app/src/pay/render.ts`, `app/src/pay/styles.ts`, `app/src/http/pay.ts`
- Modify: `app/src/app.ts` (mount pay routes)
- Create: `app/tests/pay.test.ts`

**Interfaces:**
- Consumes: `resolvePaymentLink`, `listInvoiceItems`, `startCheckout`, `formatUsd`, `payHeaders`.
- Produces routes on the pay host: `GET /i/:token`, `POST /i/:token/checkout`, `GET /i/:token/complete`, `GET /i/:token/cancel`, `GET /pay.css`, `GET /favicon.svg`.

- [ ] **Step 1: Failing tests** (`app/tests/pay.test.ts`)

`GET /i/<malformed>` → 404 HTML "Page not found" (generic; same body for malformed, unknown, revoked, void); `GET /i/<token>` for an open invoice → 200 `text/html; charset=utf-8`, body contains `MONOLITH`, `Invoice MON-00001`, the description, each item description, `$425.00`, a `<form method="post" action="/i/<token>/checkout">` with a submit button text `Pay invoice`, and no `<script`; response has the exact pay CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; description `<script>alert(1)</script>` is rendered escaped (`&lt;script&gt;`); `GET /i/<token>` for a `paid` invoice → 200 body contains `Paid` and the paid date, no form; for a `processing` invoice → 200 body says the payment is being processed (ACH), no form; `POST /i/<token>/checkout` (open) → 303 with `Location` = fake Stripe url, a `payments` row exists with `source:'payment_link'` and `payment_link_id`; `POST` for paid → 303 back to `/i/<token>` (no session created); `POST` for revoked/unknown → 404; `POST` when the gateway throws `code:'stripe_not_configured'` → 503 HTML "Payments are not available right now"; `GET /i/<token>/complete` when the invoice is `paid` → 200 "Payment received"; when `processing` → 200 "processing"; when still `open` (webhook not yet arrived) → 200 "confirming" text with a link back to `/i/<token>` (no meta refresh, no script); `GET /i/<token>/cancel` → 200 with a link back to `/i/<token>`; `GET /pay.css` → 200 `text/css` with `Cache-Control: public, max-age=3600`; `GET /favicon.svg` → 200 `image/svg+xml`; `GET /` on pay host → 404.

- [ ] **Step 2: Run to see failures**

- [ ] **Step 3: Implement**

`render.ts`: pure functions returning HTML strings: `layout({title, body})`, `invoicePage(...)`, `paidPage(...)`, `processingPage(...)`, `completePage(...)`, `cancelPage(...)`, `notFoundPage()`. All interpolated values pass through `escapeHtml`. Markup: `<!doctype html>`, `lang="en"`, viewport meta, `<link rel="stylesheet" href="/pay.css">`, `<link rel="icon" href="/favicon.svg">`, no inline styles, no scripts. Content per the spec's example: wordmark `MONOLITH`, `Invoice MON-00231`, description, items table (description, qty, amount), `Amount due` + `$425.00`, one form with a single `Pay invoice` button (Stripe Checkout offers card and bank), a note `Payments are processed securely by Stripe.`, footer `© <year> Monolith · eldritch@mnlith.dev`. `styles.ts`: the CSS string using the site palette (`#101314` background, `#edf1f2` text, `#a1aaad` muted, `rgba(220,232,237,.16)` lines, accent button `#edf1f2` on dark), system font stack, mobile-first, 16px+ text. `favicon.svg` = the site's three-bar mark (copy the SVG from `public/favicon.svg`).

`http/pay.ts`: routes as listed. Token from the path is validated with `isWellFormedToken` before any DB access. `successUrl` = `https://${hosts.pay}/i/${token}/complete`, `cancelUrl` = `.../cancel` (scheme `http` when the host is `pay.localhost`).

- [ ] **Step 4: Run tests; `npm test && npm run typecheck`**

- [ ] **Step 5: Commit** `git add app && git commit -m "Add server-rendered pay page with Stripe checkout hand-off"`

---

### Task 6: Portal invoice API and checkout

**Files:**
- Modify: `app/src/http/portal-api.ts`
- Create: `app/tests/portal-invoices.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4.
- Produces: `GET /api/invoices[?status=]`, `GET /api/invoices/:id`, `POST /api/invoices/:id/checkout` on the portal host.

- [ ] **Step 1: Failing tests**

Two clients A and B, each with an active bound membership and invoices. As A: `GET /api/invoices` returns only A's invoices (fields `id, number, status, totalCents, currency, description, issuedAt, dueAt, paidAt`), newest first; `?status=paid` filters; `GET /api/invoices/<B's id>` → 404; `GET /api/invoices/<A's id>` → 200 with `items[]` and `payments[]` (`id, status, amountCents, method, createdAt, succeededAt`); `POST /api/invoices/<A's open id>/checkout` → 201 `{url}` and a `payments` row with `source:'portal'`, `payment_link_id` null, success url `https://portal.test/invoices/<id>?checkout=complete`, cancel url `...?checkout=cancelled`; `POST` on B's invoice → 404; on `processing` → 409 `{error:'invoice_not_payable'}`; on `paid` → 409; gateway throwing `code:'stripe_not_configured'` → 503 `{error:'payments_not_configured'}`; unauthenticated → 401.

- [ ] **Step 2–4: Fail, implement, pass** (`npm test && npm run typecheck`)

- [ ] **Step 5: Commit** `git add app && git commit -m "Add client-scoped portal invoice API and checkout"`

---

### Task 7: Portal SPA (Vite + React + Clerk) and portal asset serving

**Files:**
- Create: `app/portal/index.html`, `app/portal/vite.config.ts`, `app/portal/tsconfig.json`, `app/portal/src/main.tsx`, `app/portal/src/App.tsx`, `app/portal/src/api.ts`, `app/portal/src/auth.tsx`, `app/portal/src/preview.ts`, `app/portal/src/portal.css`, `app/portal/src/screens/{Overview,Invoices,InvoiceDetail,Services,NoAccount}.tsx`
- Modify: `package.json` scripts (`app:build`, `app:portal:dev`, extend `typecheck`, `app:check`), `app/wrangler.jsonc` (none), `app/src/app.ts` (none unless needed)

**Interfaces:**
- Consumes: `/api/public-config`, `/api/me`, `/api/invoices`, `/api/invoices/:id`, `/api/invoices/:id/checkout`, `/api/services`.

- [ ] **Step 1: Build config**

`app/portal/vite.config.ts`: `root: app/portal`, `base: '/'`, `build: { outDir: '../dist/portal', emptyOutDir: true, target: 'es2022', sourcemap: false }`, React plugin, `server: { port: 5173, proxy: { '/api': 'http://localhost:8788' } }`. `app/portal/tsconfig.json`: like the root tsconfig (DOM libs, `jsx: react-jsx`, `types: ["vite/client"]`, include `src`, `vite.config.ts`). Scripts: `"app:build": "vite build --config app/portal/vite.config.ts"`, `"app:portal:dev": "vite --config app/portal/vite.config.ts --host 127.0.0.1"`, `"app:portal:preview": "vite --config app/portal/vite.config.ts --host 127.0.0.1 --mode preview"`. Preview mode is detected with `import.meta.env.DEV && import.meta.env.MODE === 'preview'` (Vite modes need no dependency; in `vite build` the condition is a constant `false` and the preview module is tree-shaken). `typecheck` adds `&& tsc --noEmit -p app/portal/tsconfig.json`; `app:check` becomes `npm run typecheck && npm run app:build && wrangler deploy --dry-run --config app/wrangler.jsonc`.

- [ ] **Step 2: App**

`main.tsx`: fetch `/api/public-config`; if `clerkPublishableKey` is empty and not preview mode, render a "Portal is not configured" screen; else render `<ClerkProvider publishableKey>` → `<App/>`. `auth.tsx`: `useApi()` returning a `fetch` wrapper that attaches `Authorization: Bearer ${await getToken()}` and throws typed errors (`401`, `403 no_account`). `App.tsx`: minimal hash-free routing with `window.location.pathname` + `history.pushState` (no router dependency): `/` Overview, `/invoices`, `/invoices/:id`, `/services`; `<SignedOut>` shows `<SignIn routing="hash" />`; a 403 `no_account` from `/api/me` routes to `NoAccount`. Screens render the data shapes from Task 3/6 exactly; `InvoiceDetail` has a `Pay invoice` button for `open` invoices that calls the checkout endpoint and sets `window.location.href = url`; when `?checkout=complete` is in the URL show "Thanks, we're confirming your payment" and re-fetch. Styling in `portal.css`: same palette and fonts as the site (`@fontsource/space-grotesk` 500, `@fontsource/manrope` 400/600 imports, colors `#101314`, `#edf1f2`, `#a1aaad`, `rgba(220,232,237,.16)`), 16px base text, focus-visible outlines, a simple header with wordmark `MONOLITH` and `Portal`, and a sign-out button (`<UserButton/>`).

`preview.ts`: when `import.meta.env.MODE === 'preview'` (dev server only), `main.tsx` skips Clerk and renders `<App/>` with a fake `useApi` backed by in-memory data (one client, three invoices in `open`/`processing`/`paid`, two services). Production builds never include this path (`if (import.meta.env.MODE === 'preview')` around a dynamic `import('./preview')`, so it is tree-shaken out of `vite build`).

- [ ] **Step 3: Verify**

```bash
npm run app:build && ls app/dist/portal/index.html && ! grep -rl "preview" app/dist/portal/assets/*.js ; npm run typecheck && npm test && npm run app:check
```
Expected: build succeeds; no production chunk contains the preview module; dry run OK. Then start `npm run app:portal:preview` and load `http://127.0.0.1:5173/`, `/invoices`, `/invoices/<id>` (use a preview invoice id), `/services`; confirm they render with no console errors (the controller takes screenshots).

- [ ] **Step 4: Commit** `git add package.json app && git commit -m "Add client portal SPA with Clerk sign-in and invoice views"`

---

### Task 8: Dev seed tooling and documentation

**Files:**
- Create: `app/scripts/seed-dev.mjs`, `app/README.md`, `docs/app-api-contract.md`
- Modify: `package.json` (`app:seed` script), `README.md` (one new section)

- [ ] **Step 1: Seed script** (`app/scripts/seed-dev.mjs`, Node, no deps)

Generates: a client `Example Co` (billing `billing@example.com`), one membership `invited` for the email given by `--email <address>` (default `client@example.com`), two services, invoices `MON-00001` (open, $425.00, description `Network Infrastructure Services`, two items), `MON-00002` (paid, $150.00), `MON-00003` (draft); a payment link for `MON-00001` (token generated with `node:crypto`, hash stored). Writes the SQL to a temp file and runs `npx wrangler d1 execute monolith-app --local --config app/wrangler.jsonc --env dev --file <tmp>`; prints the pay URL `http://pay.localhost:8788/i/<token>` and the invited email. Idempotent: refuses to run when a client named `Example Co` already exists (`--reset` deletes the seeded rows first, local DB only). Script `"app:seed": "node app/scripts/seed-dev.mjs"`.

- [ ] **Step 2: `app/README.md`** covering: purpose and the three data domains (the external PSA vendor named only as "outside this repo; not integrated"); repo layout; running locally (`npm ci`, `npm run app:migrate:local`, `npm run app:seed`, `npm run app:build`, `npm run app:dev`, then open the printed pay URL and `http://localhost:8788/`); portal preview mode; tests; environment and secrets (`.dev.vars`, what each key is, test mode only); security model (hostname routing, tenant scoping, token design, webhook idempotency, CSP per host); state machines (invoice, payment) as tables; **Activation checklist (owner, in order, all outside Phase 1)**: create Clerk dev instance and later a production instance (portal origin, session settings), create Stripe test keys and enable card + US bank account in the dashboard, create D1 `wrangler d1 create monolith-app` and set `database_id`, `wrangler secret put` for the four secrets, apply migrations `--remote`, Workers Paid decision, Custom Domains `pay.mnlith.dev` and `portal.mnlith.dev` (owner DNS approval), Stripe webhook endpoint `https://pay.mnlith.dev/api/stripe/webhook` with the listed events, then a test-mode end-to-end run with `stripe listen` locally first; **Privacy notice changes required before activation** (list, no legal text): Clerk (identity provider) and Stripe (payment processor) as processors, what they receive, portal account data, payment records retention, cookies set by Clerk on the portal host.

- [ ] **Step 3: `docs/app-api-contract.md`**: the portal API (auth, endpoints, JSON shapes, error codes `unauthenticated`, `no_account`, `not_found`, `invoice_not_payable`, `invalid_signature`), the pay host routes, the webhook contract, and the **reserved MONOLITH internal-app contract**: `Authorization: Bearer mk_<secret>` on `admin.mnlith.dev` only, credential rules (random ≥32 bytes, hash stored in `staff_api_keys`, scopes, revocation, rate limiting, server-side only, Cloudflare Access service token as production hardening), and the intended endpoints (`POST /admin/clients`, `POST /admin/clients/:id/memberships`, `POST /admin/invoices`, `POST /admin/invoices/:id/open`, `POST /admin/invoices/:id/payment-link`, `POST /admin/invoices/:id/void`) marked **not implemented in Phase 1**.

- [ ] **Step 4: Root `README.md`**: add a section `## Application platform (app/)` (3–5 sentences) pointing to `app/README.md` and stating that it is not deployed yet.

- [ ] **Step 5: Verify** `npm run app:migrate:local && npm run app:seed` (local D1 only) prints a pay URL; `npm test && npm run typecheck && npm run app:check`; a repo-wide case-insensitive search for the external PSA vendor's name prints no matches across `app`, `docs/app-api-contract.md` and `README.md` (the vendor name does not appear anywhere).

- [ ] **Step 6: Commit** `git add package.json README.md app docs/app-api-contract.md && git commit -m "Add app seed tooling, README and API contract"`

---

## Final verification (controller)

- `npm ci && npm test && npm run typecheck && npm run app:check && npm run api:check && npm run deploy:check` (site and inquiry API unchanged and still green).
- `npm run app:migrate:local && npm run app:seed && npm run app:build && npm run app:dev`: browser (Chrome) at `http://pay.localhost:8788/i/<token>` desktop + mobile screenshots, zero CSP violations; without `STRIPE_SECRET_KEY` the Pay POST renders the 503 "not available" page (Task 4 guard).
- Portal preview screenshots at desktop + mobile.
- `git diff main --stat` shows no changes under `api/`, `src/`, root `wrangler.jsonc`, `vite.config.ts`, `index.html`, `privacy.html`, `404.html`, `public/`.
