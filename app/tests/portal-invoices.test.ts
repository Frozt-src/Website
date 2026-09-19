// The portal invoice API and checkout: client-scoped listing, detail and checkout creation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { newId } from '../src/domain/ids.ts';
import { testDeps, portalUrl, FakeSessions, FakeClerkUsers, FakeStripe, json } from './helpers/app.ts';
import { seedClient, seedInvoice } from './helpers/fixtures.ts';
import { startCheckout } from '../src/domain/payments.ts';
import type { AppDeps, StripeGateway } from '../src/deps.ts';
import type { Client, Invoice } from '../src/domain/models.ts';

interface InvoiceSummaryBody {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  currency: string;
  description: string;
  issuedAt: number | null;
  dueAt: number | null;
  paidAt: number | null;
}
interface InvoiceListBody {
  invoices: InvoiceSummaryBody[];
}
interface InvoiceDetailBody extends InvoiceSummaryBody {
  items: { id: string; description: string; quantity: number; unitCents: number; amountCents: number }[];
  payments: { id: string; status: string; amountCents: number; method: string | null; createdAt: number; succeededAt: number | null }[];
}
interface CheckoutBody {
  url: string;
}

function setup() {
  let clock = 1_700_000_000;
  const sessions = new FakeSessions();
  const clerkUsers = new FakeClerkUsers();
  const stripe = new FakeStripe();
  const deps = testDeps({ sessions, clerkUsers, stripe, now: () => clock });
  return { deps, sessions, clerkUsers, stripe, app: createApp(deps), advance: (seconds: number) => { clock += seconds; } };
}

function call(
  app: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  token?: string,
): Promise<Response> {
  const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
  return app.fetch(new Request(portalUrl(path), { method, headers }));
}

async function seedMembership(
  db: D1Database,
  now: () => number,
  input: { clientId: string; email: string; clerkUserId: string },
): Promise<void> {
  const at = now();
  await db
    .prepare(`INSERT INTO memberships (id, client_id, email, clerk_user_id, role, status, bound_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, ?)`)
    .bind(newId(), input.clientId, input.email, input.clerkUserId, at, at, at)
    .run();
}

// An account that already finished first-login binding, so tests can call the API directly.
async function seedBoundAccount(
  deps: AppDeps,
  sessions: FakeSessions,
  options: { token: string; userId: string; name: string },
): Promise<Client> {
  const client = await seedClient(deps.db, deps.now, { name: options.name });
  await seedMembership(deps.db, deps.now, { clientId: client.id, email: `${options.userId}@example.com`, clerkUserId: options.userId });
  sessions.set(options.token, options.userId);
  return client;
}

async function setInvoiceStatus(deps: AppDeps, invoiceId: string, status: 'processing' | 'paid' | 'void'): Promise<void> {
  if (status === 'paid') {
    await deps.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(deps.now(), invoiceId).run();
  } else if (status === 'void') {
    await deps.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(invoiceId).run();
  } else {
    await deps.db.prepare(`UPDATE invoices SET status = 'processing' WHERE id = ?`).bind(invoiceId).run();
  }
}

function invoiceFields(invoice: Invoice) {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    totalCents: invoice.totalCents,
    currency: invoice.currency,
    description: invoice.description,
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    paidAt: invoice.paidAt,
  };
}

test('GET /api/invoices without a session is unauthenticated', async () => {
  const { app } = setup();
  const response = await call(app, 'GET', '/api/invoices');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthenticated' });
});

test('portal API responses are never cacheable, authenticated or not', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  await seedInvoice(deps.db, deps.now, a.id);

  for (const path of ['/api/me', '/api/invoices']) {
    const response = await call(app, 'GET', path, 'a');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }

  const unauthenticated = await call(app, 'GET', '/api/invoices');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('Cache-Control'), 'no-store');
});

test('GET /api/invoices lists only the caller client invoices, newest first, with the exact fields', async () => {
  const { deps, sessions, app, advance } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const b = await seedClient(deps.db, deps.now, { name: 'Client B' });

  const first = await seedInvoice(deps.db, deps.now, a.id, { description: 'First' });
  advance(60);
  const second = await seedInvoice(deps.db, deps.now, a.id, { description: 'Second' });
  await seedInvoice(deps.db, deps.now, b.id, { description: 'Other client' });

  const response = await call(app, 'GET', '/api/invoices', 'a');
  assert.equal(response.status, 200);
  const body = await json<InvoiceListBody>(response);
  assert.deepEqual(
    body.invoices.map(invoice => invoice.id),
    [second.id, first.id],
  );
  assert.deepEqual(body.invoices[0], invoiceFields(second));
});

test('GET /api/invoices?status= filters to that status', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const open = await seedInvoice(deps.db, deps.now, a.id, { description: 'Open' });
  const paid = await seedInvoice(deps.db, deps.now, a.id, { description: 'Paid' });
  await setInvoiceStatus(deps, paid.id, 'paid');

  const response = await call(app, 'GET', '/api/invoices?status=paid', 'a');
  assert.equal(response.status, 200);
  const body = await json<InvoiceListBody>(response);
  assert.deepEqual(body.invoices.map(invoice => invoice.id), [paid.id]);
  assert.notEqual(open.id, paid.id);
});

test('a draft invoice is never listed, readable or payable through the portal', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const issued = await seedInvoice(deps.db, deps.now, a.id, { description: 'Issued' });
  const draft = await seedInvoice(deps.db, deps.now, a.id, { description: 'Draft', status: 'draft' });

  const list = await call(app, 'GET', '/api/invoices', 'a');
  const body = await json<InvoiceListBody>(list);
  assert.deepEqual(body.invoices.map(invoice => invoice.id), [issued.id]);

  const detail = await call(app, 'GET', `/api/invoices/${draft.id}`, 'a');
  assert.equal(detail.status, 404);
  assert.deepEqual(await detail.json(), { error: 'not_found' });

  const checkout = await call(app, 'POST', `/api/invoices/${draft.id}/checkout`, 'a');
  assert.equal(checkout.status, 404);
  assert.deepEqual(await checkout.json(), { error: 'not_found' });
  assert.equal(stripe.calls.length, 0);
});

test('a void invoice stays in the portal history but cannot be paid', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);
  await setInvoiceStatus(deps, invoice.id, 'void');

  const list = await call(app, 'GET', '/api/invoices', 'a');
  const body = await json<InvoiceListBody>(list);
  assert.deepEqual(body.invoices.map(row => row.id), [invoice.id]);
  assert.equal((await call(app, 'GET', `/api/invoices/${invoice.id}`, 'a')).status, 200);

  const checkout = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(checkout.status, 409);
  assert.deepEqual(await checkout.json(), { error: 'invoice_not_payable' });
  assert.equal(stripe.calls.length, 0);
});

test('GET /api/invoices/:id for another client is not found', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const aInvoice = await seedInvoice(deps.db, deps.now, a.id);
  const b = await seedClient(deps.db, deps.now, { name: 'Client B' });
  const bInvoice = await seedInvoice(deps.db, deps.now, b.id);

  // Guard: the route has to exist, so the 404 below cannot come from the catch-all.
  assert.equal((await call(app, 'GET', `/api/invoices/${aInvoice.id}`, 'a')).status, 200);

  const response = await call(app, 'GET', `/api/invoices/${bInvoice.id}`, 'a');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('GET /api/invoices/:id for the caller client returns the invoice, its items and its payments', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id, {
    items: [
      { description: 'Server maintenance', quantity: 1, unitCents: 32500 },
      { description: 'On-call support', quantity: 2, unitCents: 5000 },
    ],
  });
  const checkout = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(checkout.status, 201);

  const response = await call(app, 'GET', `/api/invoices/${invoice.id}`, 'a');
  assert.equal(response.status, 200);
  const body = await json<InvoiceDetailBody>(response);

  assert.deepEqual(
    { id: body.id, number: body.number, status: body.status, totalCents: body.totalCents },
    { id: invoice.id, number: invoice.number, status: invoice.status, totalCents: invoice.totalCents },
  );
  assert.equal(body.items.length, 2);
  assert.deepEqual(
    body.items.map(item => ({
      description: item.description,
      quantity: item.quantity,
      unitCents: item.unitCents,
      amountCents: item.amountCents,
    })),
    [
      { description: 'Server maintenance', quantity: 1, unitCents: 32500, amountCents: 32500 },
      { description: 'On-call support', quantity: 2, unitCents: 5000, amountCents: 10000 },
    ],
  );
  assert.equal(body.payments.length, 1);
  assert.deepEqual(Object.keys(body.payments[0]).sort(), ['amountCents', 'createdAt', 'id', 'method', 'status', 'succeededAt']);
  assert.equal(body.payments[0].status, 'pending');
  assert.equal(body.payments[0].amountCents, invoice.totalCents);
  assert.equal(body.payments[0].method, null);
  assert.equal(body.payments[0].succeededAt, null);
});

test('POST /api/invoices/:id/checkout on the caller client open invoice creates a portal checkout session', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 201);
  const body = await json<CheckoutBody>(response);
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_00000001');

  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].successUrl, `https://portal.test/invoices/${invoice.id}?checkout=complete`);
  assert.equal(stripe.calls[0].cancelUrl, `https://portal.test/invoices/${invoice.id}?checkout=cancelled`);

  const row = await deps.db
    .prepare('SELECT source, payment_link_id FROM payments WHERE invoice_id = ?')
    .bind(invoice.id)
    .first<{ source: string; payment_link_id: string | null }>();
  assert.equal(row?.source, 'portal');
  assert.equal(row?.payment_link_id, null);
});

test('POST /api/invoices/:id/checkout keeps the port the request arrived on in the return urls', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  const response = await app.fetch(
    new Request(`https://portal.test:8788/api/invoices/${invoice.id}/checkout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer a' },
    }),
  );
  assert.equal(response.status, 201);

  const stripe = deps.stripe as FakeStripe;
  assert.equal(stripe.calls[0].successUrl, `https://portal.test:8788/invoices/${invoice.id}?checkout=complete`);
  assert.equal(stripe.calls[0].cancelUrl, `https://portal.test:8788/invoices/${invoice.id}?checkout=cancelled`);
});

test('POST /api/invoices/:id/checkout answers 409 payment_in_progress when Stripe cannot expire the other channel session', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);
  await startCheckout(deps.db, deps, {
    invoice,
    client: a,
    source: 'payment_link',
    successUrl: 'https://pay.test/checkout/complete?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://pay.test/checkout/cancel?session_id={CHECKOUT_SESSION_ID}',
  });
  stripe.expireShouldThrow = true;

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'payment_in_progress' });
});

test('POST /api/invoices/:id/checkout on another client invoice is not found and creates no session', async () => {
  const { deps, sessions, app, stripe } = setup();
  const b = await seedClient(deps.db, deps.now, { name: 'Client B' });
  const bInvoice = await seedInvoice(deps.db, deps.now, b.id);
  await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });

  const response = await call(app, 'POST', `/api/invoices/${bInvoice.id}/checkout`, 'a');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(stripe.calls.length, 0);
});

test('POST /api/invoices/:id/checkout on a processing invoice is refused', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);
  await setInvoiceStatus(deps, invoice.id, 'processing');

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'invoice_not_payable' });
  assert.equal(stripe.calls.length, 0);
});

test('POST /api/invoices/:id/checkout on a paid invoice is refused', async () => {
  const { deps, sessions, app, stripe } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);
  await setInvoiceStatus(deps, invoice.id, 'paid');

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'invoice_not_payable' });
  assert.equal(stripe.calls.length, 0);
});

test('POST /api/invoices/:id/checkout answers 503 when the Stripe call itself fails', async () => {
  const logged: string[] = [];
  const stripe: StripeGateway = {
    createCheckoutSession: async () => {
      throw new Error('stripe rate limit exceeded');
    },
    expireCheckoutSession: async () => {},
  };
  const sessions = new FakeSessions();
  const deps = testDeps({ sessions, stripe, logError: (event: string) => logged.push(event) });
  const app = createApp(deps);
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'payments_unavailable' });
  assert.deepEqual(logged, ['checkout_create_failed']);
});

test('an 11th checkout POST for the same member is throttled with 429 too_many_attempts', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  for (let i = 0; i < 10; i++) {
    const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
    assert.equal(response.status, 201);
  }

  const eleventh = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(eleventh.status, 429);
  assert.deepEqual(await eleventh.json(), { error: 'too_many_attempts', retryAfterSeconds: 600 });
  assert.equal(eleventh.headers.get('Retry-After'), '600');
});

test('checkout access for a member is restored once the throttle window expires', async () => {
  const { deps, sessions, app, advance } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  for (let i = 0; i < 10; i++) {
    await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  }
  const blocked = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(blocked.status, 429);

  advance(601);

  const restored = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(restored.status, 201);
});

test('checkout throttle counters are per member; another member is unaffected', async () => {
  const { deps, sessions, app } = setup();
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoiceA = await seedInvoice(deps.db, deps.now, a.id);
  const b = await seedBoundAccount(deps, sessions, { token: 'b', userId: 'user_b', name: 'Client B' });
  const invoiceB = await seedInvoice(deps.db, deps.now, b.id);

  for (let i = 0; i < 10; i++) {
    await call(app, 'POST', `/api/invoices/${invoiceA.id}/checkout`, 'a');
  }
  const blockedA = await call(app, 'POST', `/api/invoices/${invoiceA.id}/checkout`, 'a');
  assert.equal(blockedA.status, 429);

  const responseB = await call(app, 'POST', `/api/invoices/${invoiceB.id}/checkout`, 'b');
  assert.equal(responseB.status, 201);
});

test('POST /api/invoices/:id/checkout without Stripe configured is unavailable', async () => {
  const stripe: StripeGateway = {
    createCheckoutSession: async () => {
      throw Object.assign(new Error('stripe is not configured'), { code: 'stripe_not_configured' });
    },
    expireCheckoutSession: async () => {},
  };
  const sessions = new FakeSessions();
  const deps = testDeps({ sessions, stripe });
  const app = createApp(deps);
  const a = await seedBoundAccount(deps, sessions, { token: 'a', userId: 'user_a', name: 'Client A' });
  const invoice = await seedInvoice(deps.db, deps.now, a.id);

  const response = await call(app, 'POST', `/api/invoices/${invoice.id}/checkout`, 'a');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'payments_not_configured' });
});
