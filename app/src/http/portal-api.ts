// Portal API. Every route reads the caller's client from c.var.auth and scopes its query by it.
import { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';
import { requireClient } from '../auth/middleware.ts';
import type { AuthEnv } from '../auth/middleware.ts';
import { listServices } from '../domain/clients.ts';
import { outstandingBalanceCents } from '../domain/invoices.ts';

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

  return api;
}
