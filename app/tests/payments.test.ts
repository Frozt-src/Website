// Checkout creation and the webhook state machine, against real SQLite with fake Stripe adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { startCheckout, applyStripeEvent } from '../src/domain/payments.ts';
import { testDeps, payUrl, portalUrl, FakeStripe } from './helpers/app.ts';
import { seedClient, seedInvoice } from './helpers/fixtures.ts';
import type { AppDeps, StripeEvent } from '../src/deps.ts';
import type { Client, Invoice, InvoiceStatus, Payment } from '../src/domain/models.ts';

const successUrl = 'https://pay.test/i/the-token/complete';
const cancelUrl = 'https://pay.test/i/the-token/cancel';
const invoiceCents = 10000;

interface PaymentStateRow {
  id: string;
  status: string;
  source: string;
  payment_link_id: string | null;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  method: string | null;
  amount_cents: number;
  currency: string;
  session_expires_at: number;
  succeeded_at: number | null;
  failed_at: number | null;
}
interface InvoiceStateRow { status: string; paid_at: number | null }
interface EventStateRow { stripe_event_id: string; type: string; outcome: string; payment_id: string | null; invoice_id: string | null; payload_json: string }
interface AuditStateRow { action: string; entity_type: string; entity_id: string; client_id: string | null; details_json: string }

function setup() {
  let clock = 1_700_000_000;
  const stripe = new FakeStripe();
  const deps = testDeps({ stripe, now: () => clock });
  return { deps, stripe, advance: (seconds: number) => { clock += seconds; } };
}

async function seedPayable(deps: AppDeps): Promise<{ client: Client; invoice: Invoice }> {
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id);
  return { client, invoice };
}

async function openCheckout(deps: AppDeps): Promise<{ client: Client; invoice: Invoice; payment: Payment }> {
  const { client, invoice } = await seedPayable(deps);
  const { payment } = await startCheckout(deps.db, deps, { invoice, client, source: 'portal', successUrl, cancelUrl });
  return { client, invoice, payment };
}

let eventCounter = 0;
function checkoutEvent(
  type: string,
  session: Record<string, unknown>,
  options: { eventId?: string; livemode?: boolean } = {},
): StripeEvent {
  eventCounter += 1;
  return {
    id: options.eventId ?? `evt_test_${eventCounter}`,
    type,
    livemode: options.livemode ?? false,
    data: { object: session },
  };
}

function paidSession(payment: Payment, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: payment.stripeCheckoutSessionId,
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    amount_total: invoiceCents,
    currency: 'usd',
    payment_method_types: ['card'],
    metadata: { invoice_id: payment.invoiceId, payment_id: payment.id },
    ...overrides,
  };
}

function payment(deps: AppDeps, id: string): Promise<PaymentStateRow | null> {
  return deps.db.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<PaymentStateRow>();
}
function invoice(deps: AppDeps, id: string): Promise<InvoiceStateRow | null> {
  return deps.db.prepare('SELECT status, paid_at FROM invoices WHERE id = ?').bind(id).first<InvoiceStateRow>();
}
async function events(deps: AppDeps): Promise<EventStateRow[]> {
  return (await deps.db.prepare('SELECT * FROM payment_events').all<EventStateRow>()).results;
}
async function audits(deps: AppDeps, action: string): Promise<AuditStateRow[]> {
  return (await deps.db.prepare('SELECT * FROM audit_events WHERE action = ?').bind(action).all<AuditStateRow>()).results;
}

test('startCheckout creates a pending payment, calls the gateway with the invoice amount and audits it', async () => {
  const { deps, stripe } = setup();
  const { client, invoice: open } = await seedPayable(deps);

  const result = await startCheckout(deps.db, deps, {
    invoice: open,
    client,
    source: 'payment_link',
    successUrl,
    cancelUrl,
  });

  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const row = await payment(deps, result.payment.id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.amount_cents, invoiceCents);
  assert.equal(row?.currency, 'usd');
  assert.equal(row?.source, 'payment_link');
  assert.equal(row?.payment_link_id, null);
  assert.equal(row?.stripe_checkout_session_id, 'cs_test_1');
  assert.equal(row?.session_expires_at, deps.now() + 1800);

  assert.equal(stripe.calls.length, 1);
  assert.deepEqual(
    {
      amountCents: stripe.calls[0].amountCents,
      currency: stripe.calls[0].currency,
      invoiceNumber: stripe.calls[0].invoiceNumber,
      customerEmail: stripe.calls[0].customerEmail,
      expiresAt: stripe.calls[0].expiresAt,
      successUrl: stripe.calls[0].successUrl,
      cancelUrl: stripe.calls[0].cancelUrl,
    },
    {
      amountCents: invoiceCents,
      currency: 'usd',
      invoiceNumber: open.number,
      customerEmail: client.billingEmail,
      expiresAt: deps.now() + 1830,
      successUrl,
      cancelUrl,
    },
  );
  assert.equal(stripe.calls[0].idempotencyKey, result.payment.id);
  // Stripe rejects an expiry under 30 minutes measured by its own clock, so the session we ask for
  // outlives the one we store. Our reuse window must always close first.
  assert.equal(stripe.calls[0].expiresAt, (row?.session_expires_at ?? 0) + 30);

  const audit = await audits(deps, 'checkout.created');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_type, 'payment');
  assert.equal(audit[0].entity_id, result.payment.id);
  assert.equal(audit[0].client_id, client.id);
});

test('startCheckout reuses the pending session while it is still unexpired', async () => {
  const { deps, stripe, advance } = setup();
  const { client, invoice: open } = await seedPayable(deps);
  const input = { invoice: open, client, source: 'portal' as const, successUrl, cancelUrl };

  const first = await startCheckout(deps.db, deps, input);
  advance(1799);
  const second = await startCheckout(deps.db, deps, input);

  assert.equal(stripe.calls.length, 1);
  assert.equal(second.url, first.url);
  assert.equal(second.payment.id, first.payment.id);
  const rows = await deps.db.prepare('SELECT id FROM payments').all<{ id: string }>();
  assert.equal(rows.results.length, 1);
});

test('startCheckout opens a new session and cancels the old payment once the session expired', async () => {
  const { deps, stripe, advance } = setup();
  const { client, invoice: open } = await seedPayable(deps);
  const input = { invoice: open, client, source: 'portal' as const, successUrl, cancelUrl };

  const first = await startCheckout(deps.db, deps, input);
  advance(1801);
  const second = await startCheckout(deps.db, deps, input);

  assert.equal(stripe.calls.length, 2);
  assert.notEqual(second.payment.id, first.payment.id);
  assert.notEqual(second.url, first.url);
  assert.equal((await payment(deps, first.payment.id))?.status, 'canceled');
  assert.equal((await payment(deps, second.payment.id))?.status, 'pending');
});

for (const status of ['processing', 'paid', 'void', 'draft'] as InvoiceStatus[]) {
  test(`startCheckout refuses an invoice with status ${status}`, async () => {
    const { deps, stripe } = setup();
    const { client, invoice: open } = await seedPayable(deps);

    await assert.rejects(
      () => startCheckout(deps.db, deps, { invoice: { ...open, status }, client, source: 'portal', successUrl, cancelUrl }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'invoice_not_payable');
        return true;
      },
    );
    assert.equal(stripe.calls.length, 0);
  });
}

test('a completed and paid session marks the payment succeeded and the invoice paid', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));

  assert.equal(result.outcome, 'applied');
  const row = await payment(deps, created.id);
  assert.equal(row?.status, 'succeeded');
  assert.equal(row?.stripe_payment_intent_id, 'pi_test_1');
  assert.equal(row?.method, 'card');
  assert.equal(row?.succeeded_at, deps.now());
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'paid');
  assert.equal(billed?.paid_at, deps.now());

  const audit = await audits(deps, 'invoice.paid');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].entity_id, open.id);
});

test('replaying the same event id changes nothing and reports a duplicate', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  const event = checkoutEvent('checkout.session.completed', paidSession(created), { eventId: 'evt_replay' });

  assert.equal((await applyStripeEvent(deps.db, deps, event)).outcome, 'applied');
  const paidAt = (await invoice(deps, open.id))?.paid_at;

  assert.equal((await applyStripeEvent(deps.db, deps, event)).outcome, 'duplicate');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].stripe_event_id, 'evt_replay');
  assert.equal((await audits(deps, 'invoice.paid')).length, 1);
  assert.equal((await invoice(deps, open.id))?.paid_at, paidAt);
});

test('a completed but unpaid session moves payment and invoice to processing', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid', payment_method_types: ['card', 'us_bank_account'] })),
  );

  assert.equal(result.outcome, 'applied');
  const row = await payment(deps, created.id);
  assert.equal(row?.status, 'processing');
  assert.equal(row?.method, null);
  assert.equal((await invoice(deps, open.id))?.status, 'processing');
});

test('an async payment succeeding after processing marks the payment succeeded and the invoice paid', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })));

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.async_payment_succeeded', paidSession(created, { payment_method_types: ['us_bank_account'] })),
  );

  assert.equal(result.outcome, 'applied');
  const row = await payment(deps, created.id);
  assert.equal(row?.status, 'succeeded');
  assert.equal(row?.method, null);
  assert.equal((await invoice(deps, open.id))?.status, 'paid');
});

test('an async payment failing after processing fails the payment and reopens the invoice', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })));

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.async_payment_failed', paidSession(created, { payment_status: 'unpaid' })),
  );

  assert.equal(result.outcome, 'applied');
  const row = await payment(deps, created.id);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.failed_at, deps.now());
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'open');
  assert.equal(billed?.paid_at, null);
});

test('a late completed event does not regress an invoice an async success already paid', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  assert.equal(
    (await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.async_payment_succeeded', paidSession(created)))).outcome,
    'applied',
  );
  assert.equal((await invoice(deps, open.id))?.status, 'paid');

  const late = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })),
  );

  assert.equal(late.outcome, 'applied');
  assert.equal((await invoice(deps, open.id))?.status, 'paid');
  assert.equal((await payment(deps, created.id))?.status, 'succeeded');
});

test('an expired session cancels the payment and leaves the invoice alone', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.expired', paidSession(created, { payment_status: 'unpaid', payment_intent: null })),
  );

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'canceled');
  assert.equal((await invoice(deps, open.id))?.status, 'open');
});

test('an event for an unknown session is stored as unmatched and changes nothing', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { id: 'cs_test_unknown' })),
  );

  assert.equal(result.outcome, 'unmatched');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].outcome, 'unmatched');
  assert.equal(stored[0].payment_id, null);
  assert.equal((await payment(deps, created.id))?.status, 'pending');
  assert.equal((await invoice(deps, open.id))?.status, 'open');
});

test('a session whose amount does not match the payment is recorded as a mismatch and never pays the invoice', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { amount_total: invoiceCents - 1 })),
  );

  assert.equal(result.outcome, 'mismatch');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].outcome, 'mismatch');
  assert.equal(stored[0].payment_id, created.id);
  assert.equal((await payment(deps, created.id))?.status, 'pending');
  assert.equal((await invoice(deps, open.id))?.status, 'open');
  assert.equal((await audits(deps, 'payment.amount_mismatch')).length, 1);
});

test('a paid session carrying no amount or currency is a mismatch rather than an unverified payment', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { amount_total: undefined, currency: undefined })),
  );

  assert.equal(result.outcome, 'mismatch');
  assert.equal((await payment(deps, created.id))?.status, 'pending');
  assert.equal((await invoice(deps, open.id))?.status, 'open');
  assert.equal((await audits(deps, 'payment.amount_mismatch')).length, 1);
});

test('a paid session for an invoice that was voided meanwhile never claims the invoice was paid', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await deps.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(open.id).run();

  const result = await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'succeeded');
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'void');
  assert.equal(billed?.paid_at, null);
  assert.equal((await audits(deps, 'invoice.paid')).length, 0);
  const alarm = await audits(deps, 'payment.unexpected_invoice_state');
  assert.equal(alarm.length, 1);
  assert.equal(alarm[0].entity_id, created.id);
  assert.equal(JSON.parse(alarm[0].details_json).invoiceStatus, 'void');
});

test('a second paying event for the payment that already settled the invoice is not a suspected duplicate', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));
  const paidAt = (await invoice(deps, open.id))?.paid_at;

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.async_payment_succeeded', paidSession(created)),
  );

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'succeeded');
  assert.equal((await invoice(deps, open.id))?.paid_at, paidAt);
  assert.equal((await audits(deps, 'payment.duplicate_suspected')).length, 0);
  assert.equal((await audits(deps, 'invoice.paid')).length, 1);
});

test('the stored event row keeps the whole Stripe payload', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);
  const event = checkoutEvent('checkout.session.completed', paidSession(created));

  await applyStripeEvent(deps.db, deps, event);

  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].payload_json, JSON.stringify(event));
});

test('a livemode event is ignored while the worker runs in test mode', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created), { livemode: true }),
  );

  assert.equal(result.outcome, 'ignored');
  assert.equal((await events(deps))[0].outcome, 'ignored');
  assert.equal((await payment(deps, created.id))?.status, 'pending');
  assert.equal((await invoice(deps, open.id))?.status, 'open');
});

test('an unrelated event type is stored and ignored', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);

  const result = await applyStripeEvent(deps.db, deps, checkoutEvent('charge.refunded', paidSession(created)));

  assert.equal(result.outcome, 'ignored');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].type, 'charge.refunded');
  assert.equal(stored[0].outcome, 'ignored');
  assert.equal((await payment(deps, created.id))?.status, 'pending');
});

test('a second session completing on an already paid invoice succeeds but flags a suspected duplicate', async () => {
  const { deps, advance } = setup();
  const { client, invoice: open, payment: first } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(first)));
  const paidAt = (await invoice(deps, open.id))?.paid_at;

  advance(60);
  // A second checkout session for the same invoice, e.g. one the customer had already opened.
  const second = await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });
  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(second.payment, { payment_intent: 'pi_test_2' })),
  );

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, second.payment.id))?.status, 'succeeded');
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'paid');
  assert.equal(billed?.paid_at, paidAt);
  assert.equal((await audits(deps, 'payment.duplicate_suspected')).length, 1);
  assert.equal((await audits(deps, 'invoice.paid')).length, 1);
});

test('the pay host applies a correctly signed webhook and answers with the outcome', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/api/stripe/webhook'), {
    method: 'POST',
    headers: { 'stripe-signature': 'valid' },
    body: JSON.stringify(checkoutEvent('checkout.session.completed', paidSession(created))),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, outcome: 'applied' });
  assert.equal((await invoice(deps, open.id))?.status, 'paid');
});

test('a webhook with an invalid signature is refused and applied to nothing', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/api/stripe/webhook'), {
    method: 'POST',
    headers: { 'stripe-signature': 'nope' },
    body: JSON.stringify(checkoutEvent('checkout.session.completed', paidSession(created))),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_signature' });
  assert.equal((await events(deps)).length, 0);
});

test('a webhook without a signature header is refused', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/api/stripe/webhook'), {
    method: 'POST',
    body: JSON.stringify(checkoutEvent('checkout.session.completed', paidSession(created))),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_signature' });
});

test('a webhook body over 64 KiB is refused before it is parsed', async () => {
  const { deps } = setup();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/api/stripe/webhook'), {
    method: 'POST',
    headers: { 'stripe-signature': 'valid' },
    body: 'x'.repeat(64 * 1024 + 1),
  }));

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
});

test('the webhook route does not exist on the portal host', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);
  const app = createApp(deps);

  const response = await app.fetch(new Request(portalUrl('/api/stripe/webhook'), {
    method: 'POST',
    headers: { 'stripe-signature': 'valid' },
    body: JSON.stringify(checkoutEvent('checkout.session.completed', paidSession(created))),
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal((await events(deps)).length, 0);

  // The path is reserved for the pay host whatever the method, so it never reaches the portal auth gate.
  assert.equal((await app.fetch(new Request(portalUrl('/api/stripe/webhook')))).status, 404);
});
