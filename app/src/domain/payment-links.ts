import { newId } from './ids.ts';
import { generateToken, hashToken, isWellFormedToken } from './tokens.ts';
import { auditStatement } from './audit.ts';
import { getClient } from './clients.ts';
import { toInvoice } from './invoices.ts';
import type { InvoiceRow } from './invoices.ts';
import type { Client, Invoice, PaymentLink } from './models.ts';

interface PaymentLinkRow {
  id: string;
  invoice_id: string;
  token_hash: string;
  status: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

function toPaymentLink(row: PaymentLinkRow): PaymentLink {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    tokenHash: row.token_hash,
    status: row.status as PaymentLink['status'],
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function createPaymentLink(
  db: D1Database,
  deps: { now(): number; randomBytes(length: number): Uint8Array },
  invoiceId: string,
): Promise<{ link: PaymentLink; token: string }> {
  const token = generateToken(deps.randomBytes);
  const tokenHash = await hashToken(token);
  const id = newId();
  const createdAt = deps.now();

  // Revoke any existing active link first, in the same batch, so the one-active partial
  // unique index never sees two active rows for this invoice even momentarily.
  const revokeExisting = db
    .prepare(`UPDATE payment_links SET status = 'revoked', revoked_at = ? WHERE invoice_id = ? AND status = 'active'`)
    .bind(createdAt, invoiceId);
  const insertLink = db
    .prepare(`INSERT INTO payment_links (id, invoice_id, token_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)`)
    .bind(id, invoiceId, tokenHash, createdAt);
  const audit = auditStatement(db, {
    occurredAt: createdAt,
    actorType: 'system',
    actorId: null,
    clientId: null,
    entityType: 'payment_link',
    entityId: id,
    action: 'payment_link.created',
    detailsJson: JSON.stringify({ invoiceId }),
  });

  await db.batch([revokeExisting, insertLink, audit]);

  return {
    link: { id, invoiceId, tokenHash, status: 'active', createdAt, revokedAt: null, lastUsedAt: null },
    token,
  };
}

export async function revokePaymentLink(db: D1Database, now: () => number, linkId: string): Promise<void> {
  const revokedAt = now();
  const update = db
    .prepare(`UPDATE payment_links SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'`)
    .bind(revokedAt, linkId);
  const audit = auditStatement(db, {
    occurredAt: revokedAt,
    actorType: 'system',
    actorId: null,
    clientId: null,
    entityType: 'payment_link',
    entityId: linkId,
    action: 'payment_link.revoked',
    detailsJson: null,
  });
  await db.batch([update, audit]);
}

export async function resolvePaymentLink(
  db: D1Database,
  now: () => number,
  token: string,
): Promise<{ link: PaymentLink; invoice: Invoice; client: Client } | null> {
  if (!isWellFormedToken(token)) return null;
  const tokenHash = await hashToken(token);

  // Looked up by the unique token_hash index; the plaintext token is never scanned or compared.
  const linkRow = await db.prepare('SELECT * FROM payment_links WHERE token_hash = ?').bind(tokenHash).first<PaymentLinkRow>();
  if (!linkRow || linkRow.status !== 'active') return null;

  const invoiceRow = await db.prepare('SELECT * FROM invoices WHERE id = ?').bind(linkRow.invoice_id).first<InvoiceRow>();
  if (!invoiceRow) return null;
  const invoice = toInvoice(invoiceRow);
  if (invoice.status === 'void' || invoice.status === 'draft') return null;

  const client = await getClient(db, invoice.clientId);
  if (!client) return null;

  const lastUsedAt = now();
  await db.prepare('UPDATE payment_links SET last_used_at = ? WHERE id = ?').bind(lastUsedAt, linkRow.id).run();

  return { link: toPaymentLink({ ...linkRow, last_used_at: lastUsedAt }), invoice, client };
}
