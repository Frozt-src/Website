// The pay host: server-rendered invoice page, Stripe checkout hand-off, and completion pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createPaymentLink, revokePaymentLink } from '../src/domain/payment-links.ts';
import { testDeps, payUrl } from './helpers/app.ts';
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

  assert.match(body, /MONOLITH/);
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
  };
  const deps = testDeps({ stripe });
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/checkout`), { method: 'POST' }));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Payments are not available right now/);
});

test('the complete page shows Payment received for a paid invoice', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'paid');

  const response = await app.fetch(new Request(payUrl(`/i/${token}/complete`)));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Payment received/);
});

test('the complete page mentions processing for a processing invoice', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { invoice, token } = await seedOpenInvoiceLink(deps);
  await setInvoiceStatus(deps, invoice.id, 'processing');

  const response = await app.fetch(new Request(payUrl(`/i/${token}/complete`)));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /processing/i);
});

test('the complete page shows a confirming message and a link back, with no meta refresh or script, while the invoice is still open', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/complete`)));
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /confirming/i);
  assert.match(body, new RegExp(`href="/i/${token}"`));
  assert.ok(!body.includes('<script'));
  assert.ok(!body.toLowerCase().includes('http-equiv="refresh"'));
});

test('the cancel page links back to the invoice', async () => {
  const deps = testDeps();
  const app = createApp(deps);
  const { token } = await seedOpenInvoiceLink(deps);

  const response = await app.fetch(new Request(payUrl(`/i/${token}/cancel`)));
  assert.equal(response.status, 200);
  assert.match(await response.text(), new RegExp(`href="/i/${token}"`));
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
