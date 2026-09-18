import { newId } from './ids.ts';
import type { Invoice, InvoiceItem, InvoiceStatus } from './models.ts';

export interface InvoiceRow {
  id: string;
  client_id: string;
  number: string;
  status: string;
  currency: string;
  total_cents: number;
  description: string;
  issued_at: number | null;
  due_at: number | null;
  paid_at: number | null;
  voided_at: number | null;
  external_source: string | null;
  external_id: string | null;
  created_at: number;
  updated_at: number;
}

// Exported so other domain modules (e.g. payment-links.ts) can map an invoice row they
// already fetched themselves, without duplicating the column mapping.
export function toInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    clientId: row.client_id,
    number: row.number,
    status: row.status as InvoiceStatus,
    currency: row.currency,
    totalCents: row.total_cents,
    description: row.description,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    externalSource: row.external_source,
    externalId: row.external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit_cents: number;
  amount_cents: number;
}

function toInvoiceItem(row: InvoiceItemRow): InvoiceItem {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    position: row.position,
    description: row.description,
    quantity: row.quantity,
    unitCents: row.unit_cents,
    amountCents: row.amount_cents,
  };
}

export async function nextInvoiceNumber(db: D1Database): Promise<string> {
  const row = await db
    .prepare(`SELECT MAX(CAST(SUBSTR(number, 5) AS INTEGER)) AS max FROM invoices WHERE number LIKE 'MON-%'`)
    .first<{ max: number | null }>();
  const next = (row?.max ?? 0) + 1;
  return `MON-${String(next).padStart(5, '0')}`;
}

export interface CreateInvoiceInput {
  clientId: string;
  description: string;
  items: { description: string; quantity: number; unitCents: number }[];
  status?: 'draft' | 'open';
  issuedAt?: number | null;
  dueAt?: number | null;
}

export async function createInvoice(db: D1Database, now: () => number, input: CreateInvoiceInput): Promise<Invoice> {
  const id = newId();
  const number = await nextInvoiceNumber(db);
  const status = input.status ?? 'draft';
  const totalCents = input.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
  const timestamp = now();
  const issuedAt = input.issuedAt ?? null;
  const dueAt = input.dueAt ?? null;

  const invoiceStatement = db
    .prepare(`INSERT INTO invoices (id, client_id, number, status, currency, total_cents, description, issued_at, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, ?)`)
    .bind(id, input.clientId, number, status, totalCents, input.description, issuedAt, dueAt, timestamp, timestamp);

  const itemStatements = input.items.map((item, index) =>
    db
      .prepare(`INSERT INTO invoice_items (id, invoice_id, position, description, quantity, unit_cents, amount_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), id, index + 1, item.description, item.quantity, item.unitCents, item.quantity * item.unitCents),
  );

  await db.batch([invoiceStatement, ...itemStatements]);

  const row = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<InvoiceRow>();
  if (!row) throw new Error('invoice insert failed');
  return toInvoice(row);
}

// Both client-facing readers hide `draft`: an invoice that has not been issued is not the client's
// to see, and a 404 keeps that indistinguishable from an invoice that does not exist.
export async function getInvoiceForClient(db: D1Database, clientId: string, invoiceId: string): Promise<Invoice | null> {
  const row = await db
    .prepare(`SELECT * FROM invoices WHERE id = ? AND client_id = ? AND status <> 'draft'`)
    .bind(invoiceId, clientId)
    .first<InvoiceRow>();
  return row ? toInvoice(row) : null;
}

export async function listInvoicesForClient(db: D1Database, clientId: string, status?: InvoiceStatus): Promise<Invoice[]> {
  const statement = status
    ? db
        .prepare(`SELECT * FROM invoices WHERE client_id = ? AND status = ? AND status <> 'draft' ORDER BY created_at DESC`)
        .bind(clientId, status)
    : db.prepare(`SELECT * FROM invoices WHERE client_id = ? AND status <> 'draft' ORDER BY created_at DESC`).bind(clientId);
  const { results } = await statement.all<InvoiceRow>();
  return results.map(toInvoice);
}

export async function listInvoiceItems(db: D1Database, invoiceId: string): Promise<InvoiceItem[]> {
  const { results } = await db
    .prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY position')
    .bind(invoiceId)
    .all<InvoiceItemRow>();
  return results.map(toInvoiceItem);
}

export async function outstandingBalanceCents(db: D1Database, clientId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(total_cents), 0) AS total FROM invoices WHERE client_id = ? AND status IN ('open', 'processing')`)
    .bind(clientId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
