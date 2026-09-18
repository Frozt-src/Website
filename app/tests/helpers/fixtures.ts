// Test-only seeding helpers built on the domain functions, shared by domain and later-task tests.
import { newId } from '../../src/domain/ids.ts';
import { createInvoice } from '../../src/domain/invoices.ts';
import type { Client, Invoice } from '../../src/domain/models.ts';

export async function seedClient(
  db: D1Database,
  now: () => number,
  overrides: { name?: string; billingEmail?: string } = {},
): Promise<Client> {
  const id = newId();
  const createdAt = now();
  const name = overrides.name ?? 'Acme Corp';
  const billingEmail = overrides.billingEmail ?? 'billing@acme.test';
  await db.prepare(`INSERT INTO clients (id, name, billing_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, name, billingEmail, createdAt, createdAt)
    .run();
  return {
    id,
    name,
    billingEmail,
    status: 'active',
    stripeCustomerId: null,
    externalSource: null,
    externalId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export async function seedInvoice(
  db: D1Database,
  now: () => number,
  clientId: string,
  overrides: {
    description?: string;
    items?: { description: string; quantity: number; unitCents: number }[];
    status?: 'draft' | 'open';
    issuedAt?: number | null;
    dueAt?: number | null;
  } = {},
): Promise<Invoice> {
  return createInvoice(db, now, {
    clientId,
    description: overrides.description ?? 'Monthly services',
    items: overrides.items ?? [{ description: 'Service', quantity: 1, unitCents: 10000 }],
    status: overrides.status ?? 'open',
    issuedAt: overrides.issuedAt,
    dueAt: overrides.dueAt,
  });
}
