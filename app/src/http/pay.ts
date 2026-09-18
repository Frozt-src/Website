// Pay host routes: server-rendered invoice page, Stripe checkout hand-off, completion pages.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDeps } from '../deps.ts';
import { resolvePaymentLink } from '../domain/payment-links.ts';
import { startCheckout } from '../domain/payments.ts';
import { listInvoiceItems } from '../domain/invoices.ts';
import {
  cancelPage,
  completePage,
  faviconSvg,
  invoicePage,
  notFoundPage,
  paidPage,
  processingPage,
  unavailablePage,
} from '../pay/render.ts';
import { payCss } from '../pay/styles.ts';

function payBaseUrl(host: string): string {
  // The dev host `pay.localhost` is served over plain http; every other host is https.
  const scheme = host === 'pay.localhost' ? 'http' : 'https';
  return `${scheme}://${host}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function html(c: Context, body: string, status: 200 | 404 | 503): Response {
  return c.body(body, status, { 'Content-Type': 'text/html; charset=utf-8' });
}

export function createPayRoutes(deps: AppDeps) {
  const app = new Hono();

  app.get('/i/:token', async c => {
    const token = c.req.param('token');
    const resolved = await resolvePaymentLink(deps.db, deps.now, token);
    if (!resolved) return html(c, notFoundPage(), 404);

    const { invoice } = resolved;
    const year = new Date(deps.now() * 1000).getUTCFullYear();
    if (invoice.status === 'paid') return html(c, paidPage({ invoice, year }), 200);
    if (invoice.status === 'processing') return html(c, processingPage({ invoice, year }), 200);

    const items = await listInvoiceItems(deps.db, invoice.id);
    return html(c, invoicePage({ token, invoice, items, year }), 200);
  });

  app.post('/i/:token/checkout', async c => {
    const token = c.req.param('token');
    const resolved = await resolvePaymentLink(deps.db, deps.now, token);
    if (!resolved) return html(c, notFoundPage(), 404);

    const { invoice, client, link } = resolved;
    const base = payBaseUrl(deps.hosts.pay);
    try {
      const { url } = await startCheckout(deps.db, deps, {
        invoice,
        client,
        source: 'payment_link',
        paymentLinkId: link.id,
        successUrl: `${base}/i/${token}/complete`,
        cancelUrl: `${base}/i/${token}/cancel`,
      });
      return c.redirect(url, 303);
    } catch (error) {
      // Not open (e.g. already paid): send the payer back to the invoice, no session created.
      if (hasErrorCode(error, 'invoice_not_payable')) return c.redirect(`${base}/i/${token}`, 303);
      if (hasErrorCode(error, 'stripe_not_configured')) return html(c, unavailablePage(), 503);
      throw error;
    }
  });

  app.get('/i/:token/complete', async c => {
    const token = c.req.param('token');
    const resolved = await resolvePaymentLink(deps.db, deps.now, token);
    if (!resolved) return html(c, notFoundPage(), 404);

    const year = new Date(deps.now() * 1000).getUTCFullYear();
    return html(c, completePage({ invoice: resolved.invoice, token, year }), 200);
  });

  app.get('/i/:token/cancel', async c => {
    const token = c.req.param('token');
    const resolved = await resolvePaymentLink(deps.db, deps.now, token);
    if (!resolved) return html(c, notFoundPage(), 404);

    const year = new Date(deps.now() * 1000).getUTCFullYear();
    return html(c, cancelPage({ token, year }), 200);
  });

  app.get('/pay.css', c =>
    c.body(payCss, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }),
  );
  app.get('/favicon.svg', c => c.body(faviconSvg, 200, { 'Content-Type': 'image/svg+xml' }));

  return app;
}
