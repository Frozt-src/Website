import type { Client, Service } from './models.ts';

interface ClientRow {
  id: string;
  name: string;
  billing_email: string;
  status: string;
  stripe_customer_id: string | null;
  external_source: string | null;
  external_id: string | null;
  created_at: number;
  updated_at: number;
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    billingEmail: row.billing_email,
    status: row.status as Client['status'],
    stripeCustomerId: row.stripe_customer_id,
    externalSource: row.external_source,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getClient(db: D1Database, clientId: string): Promise<Client | null> {
  const row = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first<ClientRow>();
  return row ? toClient(row) : null;
}

interface ServiceRow {
  id: string;
  client_id: string;
  name: string;
  description: string;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    description: row.description,
    status: row.status as Service['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listServices(db: D1Database, clientId: string): Promise<Service[]> {
  const { results } = await db
    .prepare('SELECT * FROM services WHERE client_id = ? ORDER BY created_at')
    .bind(clientId)
    .all<ServiceRow>();
  return results.map(toService);
}
