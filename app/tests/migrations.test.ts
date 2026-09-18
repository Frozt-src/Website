import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { database } from './helpers/d1.ts';

function client(sql: DatabaseSync): string {
  const id = 'client-1';
  sql.prepare(`INSERT INTO clients (id, name, billing_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, 'Acme', 'billing@acme.test', 1, 1);
  return id;
}

function invoice(sql: DatabaseSync, clientId: string, id = 'inv-1'): string {
  sql.prepare(`INSERT INTO invoices (id, client_id, number, status, total_cents, description, created_at, updated_at)
    VALUES (?, ?, ?, 'open', 0, '', 1, 1)`).run(id, clientId, `MON-${id}`);
  return id;
}

test('all ten tables exist after migration', () => {
  const { sql } = database();
  const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map((row: any) => row.name as string);
  assert.deepEqual(tables, [
    'audit_events',
    'clients',
    'invoice_items',
    'invoices',
    'memberships',
    'payment_events',
    'payment_links',
    'payments',
    'services',
    'staff_api_keys',
  ]);
  sql.close();
});

test('foreign keys are enforced', () => {
  const { sql } = database();
  const row = sql.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
  assert.equal(row?.foreign_keys, 1);
  sql.close();
});

test('an invoice with an invalid status is rejected', () => {
  const { sql } = database();
  const clientId = client(sql);
  assert.throws(() => sql.prepare(`INSERT INTO invoices (id, client_id, number, status, total_cents, description, created_at, updated_at)
    VALUES (?, ?, ?, 'bogus', 0, '', 1, 1)`).run('inv-1', clientId, 'MON-00001'));
  sql.close();
});

test('only one active payment link per invoice is allowed', () => {
  const { sql } = database();
  const clientId = client(sql);
  const invoiceId = invoice(sql, clientId);
  sql.prepare(`INSERT INTO payment_links (id, invoice_id, token_hash, created_at) VALUES (?, ?, ?, ?)`)
    .run('link-1', invoiceId, 'hash-1', 1);
  assert.throws(() => sql.prepare(`INSERT INTO payment_links (id, invoice_id, token_hash, created_at) VALUES (?, ?, ?, ?)`)
    .run('link-2', invoiceId, 'hash-2', 1));
  sql.close();
});

test('invoice item amounts must equal quantity times unit price', () => {
  const { sql } = database();
  const clientId = client(sql);
  const invoiceId = invoice(sql, clientId);
  assert.throws(() => sql.prepare(`INSERT INTO invoice_items (id, invoice_id, position, description, quantity, unit_cents, amount_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('item-1', invoiceId, 1, 'Widget', 2, 500, 999));
  sql.close();
});

test('a payment referencing an unknown invoice is rejected by the foreign key', () => {
  const { sql } = database();
  const clientId = client(sql);
  assert.throws(() => sql.prepare(`INSERT INTO payments (id, invoice_id, client_id, source, stripe_checkout_session_id, amount_cents, status, session_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'portal', ?, 0, 'pending', 1, 1, 1)`).run('pay-1', 'missing-invoice', clientId, 'cs_1'));
  sql.close();
});
