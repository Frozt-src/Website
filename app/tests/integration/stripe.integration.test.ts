// Gated integration test: the real Stripe SDK in test mode against a locally running Worker.
// Skips with a printed reason when app/.dev.vars has no test keys or no Worker answers on 8788.
// Never part of `npm test` — see app/tests/integration/README.md for the runbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Stripe from 'stripe';
import { generateToken, hashToken } from '../../src/domain/tokens.ts';
import { harness, manualSkip, repoRoot, skip } from './env.ts';
import { d1, sqlString, waitFor } from './local-d1.ts';

// What `seed-dev.mjs --json` prints. Only the open invoice and the extras carry a payment link.
interface SeededInvoice {
  id: string;
  number: string;
}
interface LinkedInvoice extends SeededInvoice {
  token: string;
}
interface Seed {
  invoices: { open: LinkedInvoice; paid: SeededInvoice; draft: SeededInvoice };
  extraInvoices: LinkedInvoice[];
}
interface PaymentRow {
  id: string;
  stripe_checkout_session_id: string;
  checkout_url: string | null;
  status: string;
}
interface EventRow {
  stripe_event_id: string;
  payload_json: string;
}

// Five extra open invoices, each with its own active payment link: concurrency, ACH success,
// ACH failure, the revoked-link case and the void-invoice case all need an untouched one.
const extraInvoices = 5;
// Stripe's documented test instruments; the README names the page each one comes from.
const testCard = '4242 4242 4242 4242';
const testRouting = '110000000';
const testAccountSuccess = '000123456789';
const testAccountFailure = '000222222227';
// The manual pages are completed by a human, so the wait is generous.
const manualTimeoutMs = 10 * 60 * 1000;
// How long a CLI re-delivery is given to travel Stripe → `stripe listen` → the Worker before the
// event-row count is read back.
const resendSettleMs = 5000;

// Built on first use: the SDK refuses an empty key, and the key is only there when not skipping.
let client: Stripe | null = null;
function stripe(): Stripe {
  client ??= new Stripe(harness.stripeSecretKey, { apiVersion: Stripe.API_VERSION });
  return client;
}

let seed: Seed;

function seedDev(args: string[]): Seed {
  const stdout = execFileSync(process.execPath, [join(repoRoot, 'app/scripts/seed-dev.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(stdout.trim()) as Seed;
}

function paymentFor(invoiceId: string): PaymentRow | null {
  const rows = d1<PaymentRow>(
    `SELECT * FROM payments WHERE invoice_id = ${sqlString(invoiceId)} ORDER BY created_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

function openPaymentCount(invoiceId: string): number {
  const rows = d1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ${sqlString(invoiceId)} AND status IN ('pending', 'processing')`,
  );
  return rows[0]?.n ?? 0;
}

function invoiceStatus(invoiceId: string): string | null {
  return d1<{ status: string }>(`SELECT status FROM invoices WHERE id = ${sqlString(invoiceId)}`)[0]?.status ?? null;
}

function eventRowCount(): number {
  return d1<{ n: number }>('SELECT COUNT(*) AS n FROM payment_events')[0]?.n ?? 0;
}

// The webhook secret is the only authentication the endpoint has, so an event the test signs
// itself is indistinguishable from one Stripe sent. Only ever the test-mode secret.
function signed(payload: string, options: { secret?: string; timestamp?: number } = {}): string {
  return stripe().webhooks.generateTestHeaderString({
    payload,
    secret: options.secret ?? harness.stripeWebhookSecret,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
}

function postWebhook(payload: string, signature: string) {
  return harness.pay('/api/stripe/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

// The link the seed issues is the only way into the pay host, and the seeded paid invoice has
// none, so this test issues one with the Worker's own token helpers: the digest is stored, the
// plaintext token only ever exists here.
async function issuePaymentLink(invoiceId: string): Promise<string> {
  const token = generateToken(length => crypto.getRandomValues(new Uint8Array(length)));
  const tokenHash = await hashToken(token);
  const at = Math.floor(Date.now() / 1000);
  d1(`UPDATE payment_links SET status = 'revoked', revoked_at = ${at} WHERE invoice_id = ${sqlString(invoiceId)} AND status = 'active'`);
  d1(`INSERT INTO payment_links (id, invoice_id, token_hash, status, created_at) VALUES (${sqlString(randomUUID())}, ${sqlString(invoiceId)}, ${sqlString(tokenHash)}, 'active', ${at})`);
  return token;
}

function extra(index: number): LinkedInvoice {
  const invoice = seed.extraInvoices[index];
  assert.ok(invoice?.token, `the seed did not produce extra invoice ${index}`);
  return invoice;
}

test('the seeded payment link renders its invoice on the pay host', { skip }, async () => {
  seed = seedDev(['--reset', '--json', ...Array.from({ length: extraInvoices }, () => '--extra-invoice')]);
  assert.equal(seed.extraInvoices.length, extraInvoices);

  const response = await harness.pay(`/i/${seed.invoices.open.token}`);
  assert.equal(response.status, 200);
  assert.match(response.body, /MON-00001/);
});

test('checkout hands off to a Stripe session that matches the local payment row', { skip }, async () => {
  const response = await harness.pay(`/i/${seed.invoices.open.token}/checkout`, { method: 'POST' });
  assert.equal(response.status, 303);
  const location = response.headers['location'] ?? '';
  assert.match(location, /^https:\/\/checkout\.stripe\.com\//);

  const payment = paymentFor(seed.invoices.open.id);
  assert.ok(payment, 'no payments row was written for the seeded invoice');
  assert.equal(payment.checkout_url, location);

  const session = await stripe().checkout.sessions.retrieve(payment.stripe_checkout_session_id);
  assert.equal(session.id, payment.stripe_checkout_session_id);
  assert.equal(session.url, location);
  assert.equal(session.amount_total, 42500);
  assert.equal(session.currency, 'usd');
  assert.equal(session.client_reference_id, seed.invoices.open.id);
  assert.equal(session.metadata?.payment_id, payment.id);
  assert.equal(session.metadata?.invoice_id, seed.invoices.open.id);
});

test('two concurrent checkouts on one invoice open exactly one Stripe session', { skip }, async () => {
  const invoice = extra(0);
  const [first, second] = await Promise.all([
    harness.pay(`/i/${invoice.token}/checkout`, { method: 'POST' }),
    harness.pay(`/i/${invoice.token}/checkout`, { method: 'POST' }),
  ]);

  assert.equal(first.status, 303);
  assert.equal(second.status, 303);
  assert.equal(first.headers['location'], second.headers['location']);

  const sessions = await stripe().checkout.sessions.list({ limit: 20 });
  const mine = sessions.data.filter(session => session.metadata?.invoice_id === invoice.id);
  assert.equal(mine.length, 1, `Stripe holds ${mine.length} sessions for this invoice, expected 1`);
  assert.equal(openPaymentCount(invoice.id), 1);
});

test('a card payment marks the invoice paid and stores an applied event without the return urls', { skip: manualSkip }, async () => {
  const payment = paymentFor(seed.invoices.open.id);
  assert.ok(payment?.checkout_url, 'run the checkout test first; no checkout url is recorded');
  console.log(`\n  MANUAL STEP: open ${payment.checkout_url}`);
  console.log(`  Pay with Stripe's test card ${testCard}, any future expiry, any CVC.\n`);

  await waitFor({
    label: `the card payment on ${seed.invoices.open.number} to reach 'succeeded' (is \`stripe listen --forward-to pay.localhost:8788/api/stripe/webhook\` running?)`,
    timeoutMs: manualTimeoutMs,
    probe: () => (paymentFor(seed.invoices.open.id)?.status === 'succeeded' ? true : null),
  });

  assert.equal(invoiceStatus(seed.invoices.open.id), 'paid');
  const applied = d1<EventRow>(
    `SELECT * FROM payment_events WHERE invoice_id = ${sqlString(seed.invoices.open.id)} AND type = 'checkout.session.completed' AND outcome = 'applied'`,
  );
  assert.equal(applied.length, 1);
  assert.doesNotMatch(applied[0].payload_json, /success_url/);
});

test('an ACH payment settles the invoice through processing', { skip: manualSkip }, async () => {
  const invoice = extra(1);
  const response = await harness.pay(`/i/${invoice.token}/checkout`, { method: 'POST' });
  assert.equal(response.status, 303);
  console.log(`\n  MANUAL STEP: open ${response.headers['location']}`);
  console.log(`  Pay by US bank account, entering the details manually: routing ${testRouting}, account ${testAccountSuccess}.\n`);

  await waitFor({
    label: `the ACH payment on ${invoice.number} to reach 'processing'`,
    timeoutMs: manualTimeoutMs,
    probe: () => (paymentFor(invoice.id)?.status === 'processing' ? true : null),
  });
  assert.equal(invoiceStatus(invoice.id), 'processing');

  await waitFor({
    label: `checkout.session.async_payment_succeeded for ${invoice.number}`,
    timeoutMs: manualTimeoutMs,
    probe: () => (paymentFor(invoice.id)?.status === 'succeeded' ? true : null),
  });
  assert.equal(invoiceStatus(invoice.id), 'paid');
});

test('a failing ACH payment reopens the invoice', { skip: manualSkip }, async () => {
  const invoice = extra(2);
  const response = await harness.pay(`/i/${invoice.token}/checkout`, { method: 'POST' });
  assert.equal(response.status, 303);
  console.log(`\n  MANUAL STEP: open ${response.headers['location']}`);
  console.log(`  Pay by US bank account, entering the details manually: routing ${testRouting}, account ${testAccountFailure}.\n`);

  await waitFor({
    label: `the ACH payment on ${invoice.number} to reach 'processing'`,
    timeoutMs: manualTimeoutMs,
    probe: () => (paymentFor(invoice.id)?.status === 'processing' ? true : null),
  });
  assert.equal(invoiceStatus(invoice.id), 'processing');

  await waitFor({
    label: `checkout.session.async_payment_failed for ${invoice.number}`,
    timeoutMs: manualTimeoutMs,
    probe: () => (paymentFor(invoice.id)?.status === 'failed' ? true : null),
  });
  assert.equal(invoiceStatus(invoice.id), 'open');
});

test('a re-delivered event is reported as a duplicate and writes no second row', { skip }, async t => {
  // Stripe's own list is the source of the id, newest first. Only an event this Worker has already
  // applied can prove the duplicate path — one Stripe knows but the local database has never seen
  // would be stored as a new `unmatched` row — so the listing is matched against `payment_events`.
  const listed = await stripe().events.list({ type: 'checkout.session.completed', limit: 20 });
  const ids = listed.data.map(event => event.id);
  // One query rather than one per id: every d1() call pays an `npx wrangler` start-up.
  const applied = ids.length
    ? d1<EventRow>(
        `SELECT * FROM payment_events WHERE outcome = 'applied' AND stripe_event_id IN (${ids.map(sqlString).join(', ')})`,
      )
    : [];
  // events.list answers newest first, so the first listed id with a local row is the latest one.
  const delivered = ids.map(id => applied.find(row => row.stripe_event_id === id)).find(row => row !== undefined);
  if (!delivered) {
    // Nothing to replay: the completed-checkout step is manual and has not been run against this
    // local database yet. Reported as a skip rather than silently passing.
    t.skip('none of the last 20 checkout.session.completed events has reached the local Worker — run the card step first');
    return;
  }

  const before = eventRowCount();
  // The CLI is the closest thing to Stripe re-delivering the event itself, so it is the path taken
  // whenever it is installed.
  const cli = spawnSync('stripe', ['events', 'resend', delivered.stripe_event_id, '--confirm'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (cli.status === 0) {
    console.log(`  stripe events resend ${delivered.stripe_event_id} -> re-delivered by the CLI`);
    // The CLI prints the event, not what the Worker answered. Every outcome except `duplicate`
    // inserts a payment_events row (app/src/domain/payments.ts), so once the re-delivery has had
    // time to arrive, an unchanged row count says the same thing as `{outcome:'duplicate'}`.
    await new Promise(resolve => setTimeout(resolve, resendSettleMs));
  } else {
    console.log(
      `  stripe events resend unavailable (${cli.error?.message ?? cli.stderr?.trim() ?? `exit ${cli.status}`}); re-signing the stored payload instead`,
    );
    const response = await postWebhook(delivered.payload_json, signed(delivered.payload_json));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { received: true, outcome: 'duplicate' });
  }
  assert.equal(eventRowCount(), before);
});

test('a webhook signed with the wrong secret is rejected', { skip }, async () => {
  const payload = JSON.stringify({
    id: `evt_integration_${randomUUID()}`,
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: { id: 'cs_test_wrong_secret' } },
  });
  const response = await postWebhook(payload, signed(payload, { secret: 'whsec_not_the_real_secret' }));
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_signature' });
});

test('a webhook whose timestamp is outside the tolerance is rejected', { skip }, async () => {
  const payload = JSON.stringify({
    id: `evt_integration_${randomUUID()}`,
    type: 'checkout.session.completed',
    livemode: false,
    data: { object: { id: 'cs_test_stale' } },
  });
  const stale = Math.floor(Date.now() / 1000) - 600;
  const response = await postWebhook(payload, signed(payload, { timestamp: stale }));
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: 'invalid_signature' });
});

test('a livemode event signed with the real secret is ignored', { skip }, async () => {
  const payload = JSON.stringify({
    id: `evt_integration_${randomUUID()}`,
    type: 'checkout.session.completed',
    livemode: true,
    data: { object: { id: 'cs_live_never_matched' } },
  });
  const response = await postWebhook(payload, signed(payload));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { received: true, outcome: 'ignored' });
});

test('checkout on a paid invoice redirects back to the invoice without creating a session', { skip }, async () => {
  const token = await issuePaymentLink(seed.invoices.paid.id);
  const response = await harness.pay(`/i/${token}/checkout`, { method: 'POST' });
  assert.equal(response.status, 303);
  assert.match(response.headers['location'] ?? '', new RegExp(`/i/${token}$`));
  assert.equal(paymentFor(seed.invoices.paid.id), null);
});

test('a revoked payment link renders the generic 404', { skip }, async () => {
  const invoice = extra(3);
  d1(`UPDATE payment_links SET status = 'revoked', revoked_at = ${Math.floor(Date.now() / 1000)} WHERE invoice_id = ${sqlString(invoice.id)}`);
  const response = await harness.pay(`/i/${invoice.token}`);
  assert.equal(response.status, 404);
});

test('a void invoice renders the generic 404', { skip }, async () => {
  const invoice = extra(4);
  d1(`UPDATE invoices SET status = 'void' WHERE id = ${sqlString(invoice.id)}`);
  const response = await harness.pay(`/i/${invoice.token}`);
  assert.equal(response.status, 404);
});
