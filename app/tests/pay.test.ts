// The pay host: server-rendered invoice page, Stripe checkout hand-off, and completion pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createPaymentLink, revokePaymentLink } from '../src/domain/payment-links.ts';
import { startCheckout } from '../src/domain/payments.ts';
import { testDeps, payUrl, FakeStripe } from './helpers/app.ts';
import { seedClient, seedInvoice } from './helpers/fixtures.ts';
import type { AppDeps, StripeGateway } from '../src/deps.ts';
import type { Invoice } from '../src/domain/models.ts';

const payCsp = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";

interface PaymentRow {
  id: string;
  source: string;
  payment_link_id: string | null;
}

async function seedOpenInvoiceLink(
  deps: AppDeps,
  overrides: { description?: string; items?: { description: string; quantity: number; unitCents: number }[] } = {},
): Promise<{ invoice: Invoice; token: string }> {
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, overrides);
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  return { invoice, token };
}

async function setInvoiceStatus(deps: AppDeps, invoiceId: string, status: 'paid' | 'processing' | 'void'): Promise<void> {
  if (status === 'paid') {
    await deps.db.prepare(`UPDATE invoices SET status = 'paid', paid_at = ? WHERE id = ?`).bind(deps.now(), invoiceId).run();
  } else if (status === 'processing') {
    await deps.db.prepare(`UPDATE invoices SET status = 'processing' WHERE id = ?`).bind(invoiceId).run();
  } else {
    await deps.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(invoiceId).run();
  }
}

async function revokeLinkFor(deps: AppDeps, invoiceId: string): Promise<void> {
  const link = await deps.db.prepare('SELECT id FROM payment_links WHERE invoice_id = ?').bind(invoiceId).first<{ id: string }>();
  if (!link) throw new Error('no payment link for invoice');
  await revokePaymentLink(deps.db, deps.now, link.id);
}

async function payments(deps: AppDeps): Promise<PaymentRow[]> {
  return (await deps.db.prepare('SELECT id, source, payment_link_id FROM payments').all<PaymentRow>()).results;
}

// Lets the checkout-throttle window-expiry test advance time independently of the fixed clock the
// other tests in this file use.
function clockedDeps(): { deps: AppDeps; advance: (seconds: number) => void } {
  let clock = 1_700_000_000;
  const deps = testDeps({ now: () => clock });
  return { deps, advance: (seconds: number) => { clock += seconds; } };
}

// A payment-link checkout taken all the way through the pay host, so the return routes have a real
// Stripe session id to resolve.
async function startLinkCheckout(deps: AppDeps): Promise<{ invoice: Invoice; token: string; sessionId: string }> {
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await createApp(deps).fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  const row = await deps.db
    .prepare('SELECT stripe_checkout_session_id AS id FROM payments WHERE invoice_id = ?')
    .bind(invoice.id)
    .first<{ id: string }>();
  if (!row) throw new Error('checkout did not create a payment');
  return { invoice, token, sessionId: row.id };
}

test('a malformed token renders the generic not-found page', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const response = await app.fetch(new Request(payUrl('/i/not-a-real-token')));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test('an unknown well-formed token renders the same not-found page', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const response = await app.fetch(new Request(payUrl(`/i/${'a'.repeat(43)}`)));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test('a revoked link renders the same not-found page', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await revokeLinkFor(deps, invoice.id);
  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test('a void invoice renders the same not-found page', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'void');
  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Page not found/);
});

test('an open invoice renders the pay page with the exact security headers', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('Content-Security-Policy'), payCsp);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});

test('pay-host pages are kept out of search indexes by header and meta tag', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const page = await app.fetch(new Request(payUrl(`/i/${token}`)));
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(await page.text(), /<meta name="robots" content="noindex, nofollow">/);

  const missing = await app.fetch(new Request(payUrl(`/i/${'c'.repeat(43)}`)));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(await missing.text(), /<meta name="robots" content="noindex, nofollow">/);
});

test('an open invoice page shows the wordmark, number, description, items, amount and a checkout form', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps, {
    description: 'Managed services, September',
    items: [
      { description: 'Server maintenance', quantity: 1, unitCents: 32500 },
      { description: 'On-call support', quantity: 1, unitCents: 10000 },
    ],
  });

  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  const body = await response.text();

  assert.match(body, /<header class="wordmark">MONOLITH<\/header>/);
  assert.match(body, new RegExp(`Invoice ${invoice.number}`));
  assert.match(body, /Managed services, September/);
  assert.match(body, /Server maintenance/);
  assert.match(body, /On-call support/);
  assert.match(body, /\$425\.00/);
  assert.match(body, new RegExp(`<form method="post" action="/i/${token}/checkout">`));
  assert.match(body, /Pay invoice/);
  assert.ok(!body.includes('<script'));
});

test('an invoice description is HTML-escaped, not executed', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps, { description: '<script>alert(1)</script>' });

  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  const body = await response.text();

  assert.ok(body.includes('&lt;script&gt;'));
  assert.ok(!body.includes('<script>alert(1)</script>'));
});

test('a paid invoice shows Paid and the paid date, with no checkout form', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'paid');

  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Paid/);
  assert.ok(!body.includes('<form'));
});

test('a processing invoice explains the ACH payment is processing, with no checkout form', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'processing');

  const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /processing/i);
  assert.match(body, /ACH/);
  assert.ok(!body.includes('<form'));
});

test('checkout on an open invoice redirects to the Stripe url and records a payment_link payment', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', /^https:\/\/checkout\.stripe\.com\//);

  const rows = await payments(deps);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'payment_link');
  assert.ok(rows[0].payment_link_id);
});

test('checkout on a paid invoice redirects back to the invoice page without creating a session', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'paid');

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 303);
  assert.match(response.headers.get('Location') ?? '', new RegExp(`/i/${token}$`));
  assert.equal((await payments(deps)).length, 0);
});

test('checkout on a revoked link is a not-found response', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await revokeLinkFor(deps, invoice.id);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 404);
});

test('checkout on an unknown token is a not-found response', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${'b'.repeat(43)}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 404);
});

test('checkout returns 503 with an HTML message when Stripe is not configured', async () => {
  const stripe: StripeGateway = {
    createCheckoutSession: async () => {
      throw Object.assign(new Error('stripe is not configured'), { code: 'stripe_not_configured' });
    },
    expireCheckoutSession: async () => {},
  };
  const deps = testDeps({ stripe });
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Payments are not available right now/);
});

test('a Stripe failure renders the unavailable page and logs the event without the error text', async () => {
  const logged: string[] = [];
  const stripe: StripeGateway = {
    createCheckoutSession: async () => {
      throw new Error('stripe rate limit exceeded');
    },
    expireCheckoutSession: async () => {},
  };
  const deps = testDeps({ stripe, logError: (event: string) => logged.push(event) });
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /Payments are not available right now/);
  assert.ok(!body.includes('rate limit'));
  assert.deepEqual(logged, ['checkout_create_failed']);
});

test('checkout returns 409 with the in-progress page when Stripe cannot expire the other channel session', async () => {
  const deps = testDeps();
  const stripe = deps.stripe as FakeStripe;
  const app = createApp(deps);
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id);
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  await startCheckout(deps.db, deps, {
    invoice,
    client,
    source: 'portal',
    successUrl: 'https://portal.test/invoices/x?checkout=complete',
    cancelUrl: 'https://portal.test/invoices/x?checkout=cancelled',
  });
  stripe.expireShouldThrow = true;

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  const body = await response.text();

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(body, /A payment for this invoice is already in progress\. Please check back shortly\./);
  assert.equal((await payments(deps)).length, 1);
});

test('an 11th checkout POST against the same payment link is throttled with 429 and makes no further gateway call', async () => {
  const { deps } = clockedDeps();
  const stripe = deps.stripe as FakeStripe;
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  for (let i = 0; i < 10; i++) {
    const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
    assert.equal(response.status, 303);
  }
  const callsBeforeEleventh = stripe.calls.length;

  const eleventh = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  const body = await eleventh.text();

  assert.equal(eleventh.status, 429);
  assert.equal(eleventh.headers.get('Retry-After'), '600');
  assert.equal(eleventh.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(body, /Too many payment attempts\. Please wait a few minutes and try again\./);
  assert.equal(stripe.calls.length, callsBeforeEleventh);
});

test('checkout access for a payment link is restored once the throttle window expires', async () => {
  const { deps, advance } = clockedDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  for (let i = 0; i < 10; i++) {
    await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  }
  const blocked = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(blocked.status, 429);

  advance(601);

  const restored = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(restored.status, 303);
});

test('checkout throttle counters are per payment link; another link is unaffected', async () => {
  const { deps } = clockedDeps();
  const app = createApp(deps);
  const { token: tokenA } = await seedOpenInvoiceLink(deps);
  const { token: tokenB } = await seedOpenInvoiceLink(deps);

  for (let i = 0; i < 10; i++) {
    await app.fetch(new Request(payUrl(`/i/${tokenA}/checkout`), { method: 'POST' }));
  }
  const blockedA = await app.fetch(new Request(payUrl(`/i/${tokenA}/checkout`), { method: 'POST' }));
  assert.equal(blockedA.status, 429);

  const responseB = await app.fetch(new Request(payUrl(`/i/${tokenB}/checkout`), { method: 'POST' }));
  assert.equal(responseB.status, 303);
});

test('GET page views do not count toward the checkout throttle', async () => {
  const { deps } = clockedDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  for (let i = 0; i < 20; i++) {
    const response = await app.fetch(new Request(payUrl(`/i/${token}`)));
    assert.equal(response.status, 200);
  }
  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 303);
});

test('the checkout return urls carry the session id, never the payment-link token', async () => {
  const deps = testDeps();
  const stripe = deps.stripe as FakeStripe;
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));

  assert.equal(stripe.calls.length, 1);
  assert.equal(stripe.calls[0].successUrl, 'https://pay.test/checkout/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(stripe.calls[0].cancelUrl, 'https://pay.test/checkout/cancel?session_id={CHECKOUT_SESSION_ID}');
  assert.ok(!stripe.calls[0].successUrl.includes(token));
  assert.ok(!stripe.calls[0].cancelUrl.includes(token));
});

test('the checkout return urls keep the port the request arrived on', async () => {
  const deps = testDeps();
  const stripe = deps.stripe as FakeStripe;
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  await app.fetch(new Request(`http://pay.test:8788/i/${token}/checkout`, { method: 'POST' }));

  assert.equal(stripe.calls[0].successUrl, 'http://pay.test:8788/checkout/complete?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(stripe.calls[0].cancelUrl, 'http://pay.test:8788/checkout/cancel?session_id={CHECKOUT_SESSION_ID}');
});

test('the complete page shows Payment received with the invoice number, amount and paid date', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, sessionId } = await startLinkCheckout(deps);
  await setInvoiceStatus(deps, invoice.id, 'paid');

  const response = await app.fetch(new Request(payUrl(`/checkout/complete?session_id=${sessionId}`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Payment received/);
  assert.match(body, new RegExp(invoice.number));
  assert.match(body, /\$100\.00/);
  assert.match(body, /14 Nov 2023/);
});

test('the complete page mentions processing for a processing invoice', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, sessionId } = await startLinkCheckout(deps);
  await setInvoiceStatus(deps, invoice.id, 'processing');

  const response = await app.fetch(new Request(payUrl(`/checkout/complete?session_id=${sessionId}`)));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Your bank payment is processing/);
});

test('the complete page confirms without a token or a script while the invoice is still open', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token, sessionId } = await startLinkCheckout(deps);

  const response = await app.fetch(new Request(payUrl(`/checkout/complete?session_id=${sessionId}`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /confirming/i);
  assert.ok(!body.includes(token));
  assert.ok(!body.includes('<script'));
  assert.ok(!body.toLowerCase().includes('http-equiv="refresh"'));
});

test('the cancel page points the payer back at their invoice email and carries no token', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token, sessionId } = await startLinkCheckout(deps);

  const response = await app.fetch(new Request(payUrl(`/checkout/cancel?session_id=${sessionId}`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /Your payment was cancelled/);
  assert.match(body, /link from your invoice email/);
  assert.ok(!body.includes(token));
});

test('the cancel page spells "cancelled" with two Ls in the title and heading, matching its own body copy', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { sessionId } = await startLinkCheckout(deps);

  const response = await app.fetch(new Request(payUrl(`/checkout/cancel?session_id=${sessionId}`)));
  const body = await response.text();

  assert.match(body, /<title>Checkout cancelled<\/title>/);
  assert.match(body, /<h1>Checkout cancelled<\/h1>/);
  assert.ok(!body.includes('Checkout canceled'));
});

for (const [name, query] of [
  ['malformed', '?session_id=not-a-session'],
  ['too short', '?session_id=cs_test_abc'],
  ['missing', ''],
  ['unknown', '?session_id=cs_test_unknownsession'],
] as [string, string][]) {
  test(`a ${name} session id renders the generic not-found page on both return routes`, async () => {
    const deps = testDeps();
    const app = createApp(deps);
    await startLinkCheckout(deps);

    for (const path of ['/checkout/complete', '/checkout/cancel']) {
      const response = await app.fetch(new Request(payUrl(`${path}${query}`)));
      assert.equal(response.status, 404);
      assert.match(await response.text(), /Page not found/);
    }
  });
}

test('a portal checkout session is not resolvable through the pay-host return routes', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id);
  const { payment } = await startCheckout(deps.db, deps, {
    invoice,
    client,
    source: 'portal',
    successUrl: 'https://portal.test/invoices/x?checkout=complete',
    cancelUrl: 'https://portal.test/invoices/x?checkout=cancelled',
  });

  const response = await app.fetch(new Request(payUrl(`/checkout/complete?session_id=${payment.stripeCheckoutSessionId}`)));
  assert.equal(response.status, 404);
});

test('the old token-bearing return routes no longer exist and render the branded 404 page', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const complete = await app.fetch(new Request(payUrl(`/i/${token}/complete`)));
  assert.equal(complete.status, 404);
  assert.equal(complete.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const completeBody = await complete.text();
  assert.match(completeBody, /<header class="wordmark">MONOLITH<\/header>/);
  assert.match(completeBody, /Page not found/);

  const cancel = await app.fetch(new Request(payUrl(`/i/${token}/cancel`)));
  assert.equal(cancel.status, 404);
  assert.equal(cancel.headers.get('Content-Type'), 'text/html; charset=utf-8');
});

test('any unknown pay-host path renders the branded 404 page, not JSON', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/anything')));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const body = await response.text();
  assert.match(body, /<header class="wordmark">MONOLITH<\/header>/);
  assert.match(body, /Page not found/);
});

test('a path outside /i/ and /checkout/ renders the generic not-found variant, not the invoice-link copy', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/robots.txt')));
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.match(body, /Page not found/);
  assert.match(body, /That page doesn.t exist\./);
  assert.ok(!body.includes('This payment link is no longer valid.'));
});

test('the stylesheet is served as css with a long cache lifetime', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/pay.css')));
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Content-Type')?.startsWith('text/css'));
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=3600');
});

test('the favicon is served as an svg', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/favicon.svg')));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
});

test('the pay host root path is not found', async () => {
  const deps = testDeps();
  const app = createApp(deps);

  const response = await app.fetch(new Request(payUrl('/')));
  assert.equal(response.status, 404);
});
