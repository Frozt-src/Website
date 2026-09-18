import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { testDeps } from './helpers/app.ts';
import { seedClient, seedInvoice } from './helpers/fixtures.ts';
import { formatUsd } from '../src/domain/money.ts';
import { generateToken, isWellFormedToken, hashToken } from '../src/domain/tokens.ts';
import {
  nextInvoiceNumber,
  createInvoice,
  getInvoiceForClient,
  listInvoicesForClient,
  listInvoiceItems,
  outstandingBalanceCents,
} from '../src/domain/invoices.ts';
import { createPaymentLink, revokePaymentLink, resolvePaymentLink } from '../src/domain/payment-links.ts';

test('formatUsd renders whole dollars with cents and no thousands separator needed', () => {
  assert.equal(formatUsd(42500), '$425.00');
});

test('formatUsd inserts thousands separators for large amounts', () => {
  assert.equal(formatUsd(123456789), '$1,234,567.89');
});

test('formatUsd renders zero cents', () => {
  assert.equal(formatUsd(0), '$0.00');
});

test('generateToken returns 43 well-formed base64url characters that differ per call', () => {
  const deps = testDeps();
  const first = generateToken(deps.randomBytes);
  const second = generateToken(deps.randomBytes);
  assert.equal(first.length, 43);
  assert.ok(isWellFormedToken(first));
  assert.notEqual(first, second);
});

test('hashToken returns the sha-256 hex digest of the token', async () => {
  const expected = createHash('sha256').update('a-known-token-value').digest('hex');
  assert.equal(await hashToken('a-known-token-value'), expected);
});

test('nextInvoiceNumber starts at MON-00001 on an empty database and continues from the max', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  assert.equal(await nextInvoiceNumber(deps.db), 'MON-00001');
  for (const number of ['MON-00001', 'MON-00007']) {
    await deps.db
      .prepare(`INSERT INTO invoices (id, client_id, number, status, total_cents, description, created_at, updated_at)
        VALUES (?, ?, ?, 'open', 0, '', ?, ?)`)
      .bind(`inv-${number}`, client.id, number, deps.now(), deps.now())
      .run();
  }
  assert.equal(await nextInvoiceNumber(deps.db), 'MON-00008');
});

test('createInvoice stores the summed total and item positions 1..n', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await createInvoice(deps.db, deps.now, {
    clientId: client.id,
    description: 'Q1 services',
    items: [
      { description: 'Setup', quantity: 1, unitCents: 5000 },
      { description: 'Support', quantity: 3, unitCents: 2000 },
    ],
    status: 'open',
  });
  assert.equal(invoice.totalCents, 5000 + 3 * 2000);
  assert.equal(invoice.number, 'MON-00001');
  const items = await listInvoiceItems(deps.db, invoice.id);
  assert.deepEqual(items.map(item => item.position), [1, 2]);
  assert.equal(items[0].description, 'Setup');
  assert.equal(items[1].amountCents, 6000);
});

test('getInvoiceForClient returns null when the invoice belongs to another client', async () => {
  const deps = testDeps();
  const clientA = await seedClient(deps.db, deps.now, { name: 'A' });
  const clientB = await seedClient(deps.db, deps.now, { name: 'B' });
  const invoice = await seedInvoice(deps.db, deps.now, clientA.id);
  assert.equal(await getInvoiceForClient(deps.db, clientB.id, invoice.id), null);
  const own = await getInvoiceForClient(deps.db, clientA.id, invoice.id);
  assert.equal(own?.id, invoice.id);

  // A draft has not been issued to the client, so it does not exist as far as they are concerned.
  const draft = await seedInvoice(deps.db, deps.now, clientA.id, { status: 'draft' });
  assert.equal(await getInvoiceForClient(deps.db, clientA.id, draft.id), null);
});

test('listInvoicesForClient orders newest first, filters by status and never returns drafts', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const older = await seedInvoice(deps.db, () => 1_700_000_001, client.id, { status: 'open' });
  const newer = await seedInvoice(deps.db, () => 1_700_000_002, client.id, { status: 'open' });
  const draft = await seedInvoice(deps.db, () => 1_700_000_003, client.id, { status: 'draft' });

  const all = await listInvoicesForClient(deps.db, client.id);
  assert.deepEqual(all.map(invoice => invoice.id), [newer.id, older.id]);
  assert.ok(!all.some(invoice => invoice.id === draft.id));

  const openOnly = await listInvoicesForClient(deps.db, client.id, 'open');
  assert.deepEqual(openOnly.map(invoice => invoice.id), [newer.id, older.id]);

  // An unissued invoice is not the client's business, whatever they ask for.
  assert.deepEqual(await listInvoicesForClient(deps.db, client.id, 'draft'), []);
});

test('outstandingBalanceCents counts open and processing invoices only', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  await seedInvoice(deps.db, deps.now, client.id, {
    items: [{ description: 'Open', quantity: 1, unitCents: 1000 }],
    status: 'open',
  });
  const processing = await seedInvoice(deps.db, deps.now, client.id, {
    items: [{ description: 'Processing', quantity: 1, unitCents: 2000 }],
    status: 'open',
  });
  await deps.db.prepare(`UPDATE invoices SET status = 'processing' WHERE id = ?`).bind(processing.id).run();
  const paid = await seedInvoice(deps.db, deps.now, client.id, {
    items: [{ description: 'Paid', quantity: 1, unitCents: 4000 }],
    status: 'open',
  });
  await deps.db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).bind(paid.id).run();
  await seedInvoice(deps.db, deps.now, client.id, {
    items: [{ description: 'Draft', quantity: 1, unitCents: 8000 }],
    status: 'draft',
  });
  const voided = await seedInvoice(deps.db, deps.now, client.id, {
    items: [{ description: 'Void', quantity: 1, unitCents: 16000 }],
    status: 'open',
  });
  await deps.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(voided.id).run();

  assert.equal(await outstandingBalanceCents(deps.db, client.id), 1000 + 2000);
});

test('creating a second payment link revokes the first, and the first no longer resolves', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });

  const first = await createPaymentLink(deps.db, deps, invoice.id);
  const second = await createPaymentLink(deps.db, deps, invoice.id);
  assert.notEqual(first.link.id, second.link.id);

  const activeCount = await deps.db
    .prepare(`SELECT COUNT(*) AS count FROM payment_links WHERE invoice_id = ? AND status = 'active'`)
    .bind(invoice.id)
    .first<number>('count');
  assert.equal(activeCount, 1);

  assert.equal(await resolvePaymentLink(deps.db, deps.now, first.token), null);
  const resolvedSecond = await resolvePaymentLink(deps.db, deps.now, second.token);
  assert.equal(resolvedSecond?.link.id, second.link.id);
});

test('resolvePaymentLink returns null for malformed tokens', async () => {
  const deps = testDeps();
  for (const token of ['abc', 'a'.repeat(44), '+'.repeat(43)]) {
    assert.equal(await resolvePaymentLink(deps.db, deps.now, token), null);
  }
});

test('resolvePaymentLink returns null for an unknown well-formed token', async () => {
  const deps = testDeps();
  const unknownToken = generateToken(deps.randomBytes);
  assert.equal(await resolvePaymentLink(deps.db, deps.now, unknownToken), null);
});

test('resolvePaymentLink returns null for a revoked link', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });
  const { link, token } = await createPaymentLink(deps.db, deps, invoice.id);
  await revokePaymentLink(deps.db, deps.now, link.id);
  assert.equal(await resolvePaymentLink(deps.db, deps.now, token), null);
});

test('resolvePaymentLink returns null for a void invoice', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });
  await deps.db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).bind(invoice.id).run();
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  assert.equal(await resolvePaymentLink(deps.db, deps.now, token), null);
});

test('resolvePaymentLink returns null for a draft invoice', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'draft' });
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  assert.equal(await resolvePaymentLink(deps.db, deps.now, token), null);
});

test('resolvePaymentLink resolves an open invoice and sets last_used_at', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  const resolved = await resolvePaymentLink(deps.db, deps.now, token);
  assert.equal(resolved?.invoice.id, invoice.id);
  assert.equal(resolved?.client.id, client.id);
  assert.equal(resolved?.link.lastUsedAt, deps.now());
});

test('resolvePaymentLink resolves a paid invoice', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });
  await deps.db.prepare(`UPDATE invoices SET status = 'paid' WHERE id = ?`).bind(invoice.id).run();
  const { token } = await createPaymentLink(deps.db, deps, invoice.id);
  const resolved = await resolvePaymentLink(deps.db, deps.now, token);
  assert.equal(resolved?.invoice.status, 'paid');
});

test('payment link creation and revocation are audited, and details_json never contains the token', async () => {
  const deps = testDeps();
  const client = await seedClient(deps.db, deps.now);
  const invoice = await seedInvoice(deps.db, deps.now, client.id, { status: 'open' });
  const { link, token } = await createPaymentLink(deps.db, deps, invoice.id);
  await revokePaymentLink(deps.db, deps.now, link.id);

  const { results } = await deps.db
    .prepare(`SELECT action, details_json FROM audit_events WHERE entity_id = ? ORDER BY action`)
    .bind(link.id)
    .all<{ action: string; details_json: string | null }>();

  const actions = results.map(row => row.action);
  assert.ok(actions.includes('payment_link.created'));
  assert.ok(actions.includes('payment_link.revoked'));
  for (const row of results) {
    assert.ok(!row.details_json || !row.details_json.includes(token));
  }
});
