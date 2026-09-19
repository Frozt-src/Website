// Checkout creation and the webhook state machine, against real SQLite with fake Stripe adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createPaymentLink } from '../src/domain/payment-links.ts';
import { startCheckout, applyStripeEvent, invoiceForPaymentLinkSession } from '../src/domain/payments.ts';
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
    // Automatic payment methods list every method enabled on the account, which is what production
    // sessions carry; a single-entry list is the only unambiguous case.
    payment_method_types: ['card', 'us_bank_account'],
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

  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_00000001');
  const row = await payment(deps, result.payment.id);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.amount_cents, invoiceCents);
  assert.equal(row?.currency, 'usd');
  assert.equal(row?.source, 'payment_link');
  assert.equal(row?.payment_link_id, null);
  assert.equal(row?.stripe_checkout_session_id, 'cs_test_00000001');
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
  assert.deepEqual(stripe.expired, []);
  const rows = await deps.db.prepare('SELECT id FROM payments').all<{ id: string }>();
  assert.equal(rows.results.length, 1);
});

test('a checkout from the other source expires the pending session instead of reusing it', async () => {
  const { deps, stripe } = setup();
  const { client, invoice: open } = await seedPayable(deps);

  const link = await startCheckout(deps.db, deps, { invoice: open, client, source: 'payment_link', successUrl, cancelUrl });
  const portal = await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });

  assert.equal(stripe.calls.length, 2);
  assert.notEqual(portal.payment.id, link.payment.id);
  assert.notEqual(portal.url, link.url);
  // The session Stripe still holds open for the other channel is closed, not left payable.
  assert.deepEqual(stripe.expired, [link.payment.stripeCheckoutSessionId]);
  assert.equal((await payment(deps, link.payment.id))?.status, 'canceled');
  const fresh = await payment(deps, portal.payment.id);
  assert.equal(fresh?.status, 'pending');
  assert.equal(fresh?.source, 'portal');
});

test('a checkout from the other source throws payment_in_progress when Stripe cannot expire the pending session, without creating a second one', async () => {
  const { deps, stripe } = setup();
  const { client, invoice: open } = await seedPayable(deps);
  const first = await startCheckout(deps.db, deps, { invoice: open, client, source: 'payment_link', successUrl, cancelUrl });
  stripe.expireShouldThrow = true;

  await assert.rejects(
    () => startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'payment_in_progress');
      return true;
    },
  );

  // No second live session was created, and the first payment is untouched.
  assert.equal(stripe.calls.length, 1);
  const rows = await deps.db.prepare('SELECT id, status, source FROM payments').all<{ id: string; status: string; source: string }>();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].id, first.payment.id);
  assert.equal(rows.results[0].status, 'pending');
  assert.equal(rows.results[0].source, 'payment_link');
});

test('a payment_in_progress failure logs checkout_expire_failed before throwing', async () => {
  const { deps: baseDeps, stripe } = setup();
  const logged: { event: string; error: unknown }[] = [];
  const deps = { ...baseDeps, logError: (event: string, error: unknown) => logged.push({ event, error }) };
  const { client, invoice: open } = await seedPayable(deps);
  await startCheckout(deps.db, deps, { invoice: open, client, source: 'payment_link', successUrl, cancelUrl });
  stripe.expireShouldThrow = true;

  await assert.rejects(
    () => startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'payment_in_progress');
      return true;
    },
  );

  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, 'checkout_expire_failed');
  assert.ok(logged[0].error instanceof Error);
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

for (const status of ['void', 'draft'] as InvoiceStatus[]) {
  test(`invoiceForPaymentLinkSession returns null once the invoice is ${status}`, async () => {
    const { deps } = setup();
    const { client, invoice: open } = await seedPayable(deps);
    const { payment: created } = await startCheckout(deps.db, deps, {
      invoice: open,
      client,
      source: 'payment_link',
      successUrl,
      cancelUrl,
    });
    await deps.db.prepare(`UPDATE invoices SET status = ? WHERE id = ?`).bind(status, open.id).run();

    const resolved = await invoiceForPaymentLinkSession(deps.db, created.stripeCheckoutSessionId);

    assert.equal(resolved, null);
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
  // Automatic payment methods make the offered list ambiguous, so no method is claimed.
  assert.equal(row?.method, null);
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
  // Exactly one offered method is unambiguous, so it is recorded.
  assert.equal(row?.method, 'us_bank_account');
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

test('a late completed event never moves an invoice whose async payment already failed', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })));
  await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.async_payment_failed', paidSession(created, { payment_status: 'unpaid' })),
  );
  assert.equal((await invoice(deps, open.id))?.status, 'open');

  const late = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })),
  );

  assert.equal(late.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'failed');
  // Not stranded in processing: no further Stripe event would ever move it back.
  assert.equal((await invoice(deps, open.id))?.status, 'open');
});

test('a late paid completion after a failed async payment neither succeeds the payment nor pays the invoice', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })));
  await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.async_payment_failed', paidSession(created, { payment_status: 'unpaid' })),
  );

  const late = await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));

  assert.equal(late.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'failed');
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'open');
  assert.equal(billed?.paid_at, null);
  // The audit must follow what the invoice update actually did, not what the event asked for.
  assert.equal((await audits(deps, 'invoice.paid')).length, 0);
});

test('a session charged inside the cancellation cushion still succeeds and pays the invoice', async () => {
  const { deps, advance } = setup();
  const { client, invoice: open } = await seedPayable(deps);
  const first = await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });
  advance(1801);
  await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });
  assert.equal((await payment(deps, first.payment.id))?.status, 'canceled');

  const result = await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(first.payment)));

  assert.equal(result.outcome, 'applied');
  const row = await payment(deps, first.payment.id);
  assert.equal(row?.status, 'succeeded');
  assert.equal(row?.stripe_payment_intent_id, 'pi_test_1');
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'paid');
  assert.equal(billed?.paid_at, deps.now());
  assert.equal((await audits(deps, 'invoice.paid')).length, 1);
  assert.equal((await audits(deps, 'payment.duplicate_suspected')).length, 0);
});

test('a canceled session charged after its replacement settled the invoice is flagged as a duplicate', async () => {
  const { deps, advance } = setup();
  const { client, invoice: open } = await seedPayable(deps);
  const first = await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });
  advance(1801);
  const second = await startCheckout(deps.db, deps, { invoice: open, client, source: 'portal', successUrl, cancelUrl });
  await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.completed', paidSession(second.payment, { payment_intent: 'pi_test_2' })),
  );
  const paidAt = (await invoice(deps, open.id))?.paid_at;

  const result = await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(first.payment)));

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, first.payment.id))?.status, 'succeeded');
  const billed = await invoice(deps, open.id);
  assert.equal(billed?.status, 'paid');
  assert.equal(billed?.paid_at, paidAt);
  assert.equal((await audits(deps, 'payment.duplicate_suspected')).length, 1);
  assert.equal((await audits(deps, 'invoice.paid')).length, 1);
});

test('an expired event after the payment reached processing leaves it processing', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created, { payment_status: 'unpaid' })));

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('checkout.session.expired', paidSession(created, { payment_status: 'unpaid' })),
  );

  assert.equal(result.outcome, 'applied');
  assert.equal((await payment(deps, created.id))?.status, 'processing');
  assert.equal((await invoice(deps, open.id))?.status, 'processing');
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

test('the stored event row keeps the Stripe payload apart from the return urls', async () => {
  const { deps } = setup();
  const { payment: created } = await openCheckout(deps);
  const event = checkoutEvent('checkout.session.completed', paidSession(created));

  await applyStripeEvent(deps.db, deps, event);

  const stored = await events(deps);
  assert.equal(stored.length, 1);
  const payload = JSON.parse(stored[0].payload_json);
  assert.equal(payload.id, event.id);
  assert.equal(payload.type, 'checkout.session.completed');
  assert.equal(payload.data.object.payment_status, 'paid');
  assert.deepEqual(payload.data.object.metadata, { invoice_id: created.invoiceId, payment_id: created.id });
});

test('a payment-link event never stores the plaintext token Stripe echoes back in the return urls', async () => {
  const { deps } = setup();
  const app = createApp(deps);
  const client = await seedClient(deps.db, deps.now);
  const open = await seedInvoice(deps.db, deps.now, client.id);
  const { token } = await createPaymentLink(deps.db, deps, open.id);
  await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  const created = (await deps.db.prepare('SELECT * FROM payments WHERE invoice_id = ?').bind(open.id).first<PaymentStateRow>())!;

  // The shape a real Stripe session had before the return urls stopped carrying the token.
  const session = paidSession({ id: created.id, invoiceId: open.id, stripeCheckoutSessionId: created.stripe_checkout_session_id } as Payment, {
    success_url: `https://pay.test/i/${token}/complete`,
    cancel_url: `https://pay.test/i/${token}/cancel`,
    url: `https://checkout.stripe.com/c/pay/${created.stripe_checkout_session_id}#fid`,
  });
  const event = checkoutEvent('checkout.session.completed', session);

  const result = await applyStripeEvent(deps.db, deps, event);

  assert.equal(result.outcome, 'applied');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].payload_json.includes(token));
  assert.ok(!stored[0].payload_json.includes('success_url'));
  assert.ok(!stored[0].payload_json.includes('cancel_url'));
  assert.ok(!stored[0].payload_json.includes('"url"'));
  // The in-memory event is untouched, so nothing downstream loses fields.
  assert.equal(event.data.object.success_url, `https://pay.test/i/${token}/complete`);

  const auditRows = await deps.db.prepare('SELECT details_json FROM audit_events').all<{ details_json: string | null }>();
  assert.ok(auditRows.results.length > 0);
  for (const row of auditRows.results) assert.ok(!(row.details_json ?? '').includes(token));
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
  assert.equal(stored[0].payment_id, null);
  assert.equal((await payment(deps, created.id))?.status, 'pending');
});

test('a refund event is stored against the payment and invoice it belongs to', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));

  const result = await applyStripeEvent(
    deps.db,
    deps,
    checkoutEvent('charge.refunded', { id: 'ch_test_1', payment_intent: 'pi_test_1', amount_refunded: invoiceCents }),
  );

  assert.equal(result.outcome, 'ignored');
  const refund = (await events(deps)).find(row => row.type === 'charge.refunded');
  assert.equal(refund?.payment_id, created.id);
  assert.equal(refund?.invoice_id, open.id);
  // Phase 1 records refunds and disputes for history only; no state changes.
  assert.equal((await payment(deps, created.id))?.status, 'succeeded');
  assert.equal((await invoice(deps, open.id))?.status, 'paid');
});

test('a signed event with no data.object is stored as ignored and never throws', async () => {
  const { deps } = setup();
  const event = {
    id: 'evt_no_object',
    type: 'charge.refunded',
    livemode: false,
    data: { object: null },
  } as unknown as StripeEvent;

  const result = await applyStripeEvent(deps.db, deps, event);

  assert.equal(result.outcome, 'ignored');
  const stored = await events(deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].outcome, 'ignored');
  assert.equal(stored[0].payment_id, null);
  assert.equal(stored[0].invoice_id, null);
});

test('a payment_intent event is linked through the object id', async () => {
  const { deps } = setup();
  const { invoice: open, payment: created } = await openCheckout(deps);
  await applyStripeEvent(deps.db, deps, checkoutEvent('checkout.session.completed', paidSession(created)));

  await applyStripeEvent(deps.db, deps, checkoutEvent('payment_intent.succeeded', { id: 'pi_test_1' }));

  const linked = (await events(deps)).find(row => row.type === 'payment_intent.succeeded');
  assert.equal(linked?.outcome, 'ignored');
  assert.equal(linked?.payment_id, created.id);
  assert.equal(linked?.invoice_id, open.id);
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

test('a streamed webhook body with no Content-Length is cut off at the cap, not buffered whole', async () => {
  const { deps } = setup();
  const app = createApp(deps);
  const kib = new TextEncoder().encode('x'.repeat(1024));
  let sent = 0;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 70) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(kib);
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request(payUrl('/api/stripe/webhook'), {
    method: 'POST',
    headers: { 'stripe-signature': 'valid' },
    body,
    duplex: 'half',
  } as RequestInit);

  const response = await app.fetch(request);

  assert.equal(request.headers.get('Content-Length'), null);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  assert.equal((await events(deps)).length, 0);
  // The point of reading as a stream: the oversized body is abandoned, never held in memory.
  assert.ok(canceled, 'the request stream was cancelled');
  assert.ok(sent <= 66, `read ${sent} KiB before stopping`);
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
