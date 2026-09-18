// Pay host routes: server-rendered invoice page, Stripe checkout hand-off, completion pages.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppDeps } from '../deps.ts';
import { resolvePaymentLink } from '../domain/payment-links.ts';
import { invoiceForPaymentLinkSession, startCheckout } from '../domain/payments.ts';
import { listInvoiceItems } from '../domain/invoices.ts';
import {
  cancelPage,
  completePage,
  faviconSvg,
  invoicePage,
  notFoundPage,
  paidPage,
  paymentInProgressPage,
  processingPage,
  unavailablePage,
} from '../pay/render.ts';
import { payCss } from '../pay/styles.ts';

// Stripe substitutes the literal placeholder when it redirects the payer back.
const sessionIdPlaceholder = '{CHECKOUT_SESSION_ID}';
const checkoutSessionId = /^cs_(test|live)_[A-Za-z0-9]{8,}$/;

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function html(c: Context, body: string, status: 200 | 404 | 409 | 503): Response {
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
    // The origin the payer actually reached us on, so the dev port survives the Stripe round trip.
    const base = new URL(c.req.url).origin;
    try {
      const { url } = await startCheckout(deps.db, deps, {
        invoice,
        client,
        source: 'payment_link',
        paymentLinkId: link.id,
        successUrl: `${base}/checkout/complete?session_id=${sessionIdPlaceholder}`,
        cancelUrl: `${base}/checkout/cancel?session_id=${sessionIdPlaceholder}`,
      });
      return c.redirect(url, 303);
    } catch (error) {
      // Not open (e.g. already paid): send the payer back to the invoice, no session created.
      if (hasErrorCode(error, 'invoice_not_payable')) return c.redirect(`${base}/i/${token}`, 303);
      if (hasErrorCode(error, 'payment_in_progress')) {
        const year = new Date(deps.now() * 1000).getUTCFullYear();
        return html(c, paymentInProgressPage({ invoice, year }), 409);
      }
      if (hasErrorCode(error, 'stripe_not_configured')) return html(c, unavailablePage(), 503);
      // Any other Stripe failure (rate limit, network, rejected amount) is the payer's problem to
      // retry, not a bare 500. The error itself never reaches the response.
      deps.logError('checkout_create_failed', error);
      return html(c, unavailablePage(), 503);
    }
  });

  // Stripe returns the payer here with the session id only; the token never leaves the Worker.
  const invoiceForReturn = async (sessionId: string | undefined) => {
    if (!sessionId || !checkoutSessionId.test(sessionId)) return null;
    return invoiceForPaymentLinkSession(deps.db, sessionId);
  };

  app.get('/checkout/complete', async c => {
    const invoice = await invoiceForReturn(c.req.query('session_id'));
    if (!invoice) return html(c, notFoundPage(), 404);

    const year = new Date(deps.now() * 1000).getUTCFullYear();
    return html(c, completePage({ invoice, year }), 200);
  });

  app.get('/checkout/cancel', async c => {
    const invoice = await invoiceForReturn(c.req.query('session_id'));
    if (!invoice) return html(c, notFoundPage(), 404);

    const year = new Date(deps.now() * 1000).getUTCFullYear();
    return html(c, cancelPage({ year }), 200);
  });

  app.get('/pay.css', c =>
    c.body(payCss, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }),
  );
  app.get('/favicon.svg', c => c.body(faviconSvg, 200, { 'Content-Type': 'image/svg+xml' }));

  return app;
}
