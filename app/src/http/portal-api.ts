// Portal API. Every route reads the caller's client from c.var.auth and scopes its query by it.
import { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { requireClient } from '../auth/middleware.ts';
import type { AuthEnv } from '../auth/middleware.ts';
import { listServices } from '../domain/clients.ts';
import { getInvoiceForClient, listInvoiceItems, listInvoicesForClient, outstandingBalanceCents } from '../domain/invoices.ts';
import { listPaymentsForInvoice, startCheckout } from '../domain/payments.ts';
import type { InvoiceStatus } from '../domain/models.ts';

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function portalBaseUrl(host: string): string {
  // The dev host `localhost` is served over plain http; every other host is https.
  const scheme = host === 'localhost' ? 'http' : 'https';
  return `${scheme}://${host}`;
}

export function createPortalApi(deps: AppDeps) {
  const api = new Hono<AuthEnv>();
  api.use('*', requireClient(deps));

  api.get('/me', async c => {
    const { userId, membership, client } = c.var.auth;
    return c.json({
      user: { id: userId },
      membership: { id: membership.id, role: membership.role, status: membership.status },
      client: { id: client.id, name: client.name, billingEmail: client.billingEmail },
      balanceCents: await outstandingBalanceCents(deps.db, client.id),
    });
  });

  api.get('/clients/:id', c => {
    const { client } = c.var.auth;
    if (c.req.param('id') !== client.id) return c.json({ error: 'not_found' }, 404);
    return c.json({ id: client.id, name: client.name, billingEmail: client.billingEmail });
  });

  api.get('/services', async c => {
    const services = await listServices(deps.db, c.var.auth.client.id);
    return c.json({
      services: services.map(service => ({
        id: service.id,
        name: service.name,
        description: service.description,
        status: service.status,
        startedAt: service.startedAt,
        endedAt: service.endedAt,
      })),
    });
  });

  api.get('/invoices', async c => {
    const { client } = c.var.auth;
    const status = c.req.query('status') as InvoiceStatus | undefined;
    const invoices = await listInvoicesForClient(deps.db, client.id, status);
    return c.json({
      invoices: invoices.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
        description: invoice.description,
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        paidAt: invoice.paidAt,
      })),
    });
  });

  api.get('/invoices/:id', async c => {
    const { client } = c.var.auth;
    const invoice = await getInvoiceForClient(deps.db, client.id, c.req.param('id'));
    if (!invoice) return c.json({ error: 'not_found' }, 404);

    const [items, payments] = await Promise.all([
      listInvoiceItems(deps.db, invoice.id),
      listPaymentsForInvoice(deps.db, invoice.id),
    ]);
    return c.json({
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      totalCents: invoice.totalCents,
      currency: invoice.currency,
      description: invoice.description,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      items: items.map(item => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unitCents: item.unitCents,
        amountCents: item.amountCents,
      })),
      payments: payments.map(payment => ({
        id: payment.id,
        status: payment.status,
        amountCents: payment.amountCents,
        method: payment.method,
        createdAt: payment.createdAt,
        succeededAt: payment.succeededAt,
      })),
    });
  });

  api.post('/invoices/:id/checkout', async c => {
    const { client } = c.var.auth;
    const invoice = await getInvoiceForClient(deps.db, client.id, c.req.param('id'));
    if (!invoice) return c.json({ error: 'not_found' }, 404);

    const base = portalBaseUrl(deps.hosts.portal);
    try {
      const { url } = await startCheckout(deps.db, deps, {
        invoice,
        client,
        source: 'portal',
        successUrl: `${base}/invoices/${invoice.id}?checkout=complete`,
        cancelUrl: `${base}/invoices/${invoice.id}?checkout=cancelled`,
      });
      return c.json({ url }, 201);
    } catch (error) {
      if (hasErrorCode(error, 'invoice_not_payable')) return c.json({ error: 'invoice_not_payable' }, 409);
      if (hasErrorCode(error, 'stripe_not_configured')) return c.json({ error: 'payments_not_configured' }, 503);
      throw error;
    }
  });

  return api;
}
