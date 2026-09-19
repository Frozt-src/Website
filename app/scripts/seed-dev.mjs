#!/usr/bin/env node
// Seeds a demo client so the pay page and portal have something to show. By default this targets
// the local D1 database (`app/.wrangler/state`). With --staging --i-understand-remote-staging it
// targets the remote staging D1 (`monolith-app-staging`) instead; there is no flag to target
// production. Node built-ins only, no dependencies.
// Usage: node app/scripts/seed-dev.mjs [--email <address>] [--reset]
//        node app/scripts/seed-dev.mjs --staging --i-understand-remote-staging [--email <address>] [--reset]

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wranglerConfig = 'app/wrangler.jsonc';
const clientName = 'Example Co';

function parseArgs(argv) {
  let email = 'client@example.com';
  let reset = false;
  let staging = false;
  let iUnderstandRemoteStaging = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--email') {
      email = argv[++i];
      if (!email) throw new Error('--email requires a value');
    } else if (arg === '--reset') {
      reset = true;
    } else if (arg === '--staging') {
      staging = true;
    } else if (arg === '--i-understand-remote-staging') {
      iUnderstandRemoteStaging = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (staging && !iUnderstandRemoteStaging) {
    throw new Error(
      '--staging writes to the remote staging D1 database; pass --i-understand-remote-staging to confirm.',
    );
  }
  return { email, reset, staging };
}

// execSync always runs through a shell, so array args are not auto-quoted for us; only the pieces
// that can contain whitespace (SQL text, file paths) need quoting here.
function quoteArg(value) {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function runWranglerJson(args) {
  const command = `npx ${['wrangler', ...args].map(quoteArg).join(' ')}`;
  const stdout = execSync(command, { cwd: repoRoot, encoding: 'utf8' });
  return JSON.parse(stdout.trim());
}

function runWranglerFile(sqlPath) {
  const command = `npx ${['wrangler', 'd1', 'execute', databaseName, resourceFlag, '--config', wranglerConfig, '--env', envName, '--json', '--file', sqlPath].map(quoteArg).join(' ')}`;
  execSync(command, { cwd: repoRoot, encoding: 'utf8' });
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertInvoice({ id, clientId, number, status, totalCents, description, issuedAt, dueAt, paidAt }) {
  return `INSERT INTO invoices (id, client_id, number, status, currency, total_cents, description, issued_at, due_at, paid_at, created_at, updated_at)
    VALUES (${sqlString(id)}, ${sqlString(clientId)}, ${sqlString(number)}, ${sqlString(status)}, 'usd', ${totalCents}, ${sqlString(description)}, ${issuedAt ?? 'NULL'}, ${dueAt ?? 'NULL'}, ${paidAt ?? 'NULL'}, ${now}, ${now});`;
}

function insertInvoiceItem({ id, invoiceId, position, description, quantity, unitCents }) {
  const amountCents = quantity * unitCents;
  return `INSERT INTO invoice_items (id, invoice_id, position, description, quantity, unit_cents, amount_cents)
    VALUES (${sqlString(id)}, ${sqlString(invoiceId)}, ${position}, ${sqlString(description)}, ${quantity}, ${unitCents}, ${amountCents});`;
}

function insertService({ id, clientId, name, description, startedAt }) {
  return `INSERT INTO services (id, client_id, name, description, status, started_at, created_at, updated_at)
    VALUES (${sqlString(id)}, ${sqlString(clientId)}, ${sqlString(name)}, ${sqlString(description)}, 'active', ${startedAt}, ${now}, ${now});`;
}

const { email, reset, staging } = parseArgs(process.argv.slice(2));
const databaseName = 'monolith-app-staging';
const envName = staging ? 'staging' : 'dev';
const resourceFlag = staging ? '--remote' : '--local';
const now = Math.floor(Date.now() / 1000);
const day = 86400;

const existing = runWranglerJson([
  'd1', 'execute', databaseName, resourceFlag, '--config', wranglerConfig, '--env', envName, '--json',
  '--command', `SELECT id FROM clients WHERE name = ${sqlString(clientName)} LIMIT 1`,
])[0].results[0];

if (existing && !reset) {
  console.error(`A client named "${clientName}" already exists in the ${envName} database (id ${existing.id}).`);
  console.error('Re-run with --reset to delete the seeded rows and recreate them.');
  process.exit(1);
}

const statements = [];

if (existing) {
  const clientId = sqlString(existing.id);
  statements.push(
    `DELETE FROM payment_events WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id = ${clientId});`,
    `DELETE FROM payments WHERE client_id = ${clientId};`,
    `DELETE FROM payment_links WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id = ${clientId});`,
    `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id = ${clientId});`,
    `DELETE FROM invoices WHERE client_id = ${clientId};`,
    `DELETE FROM services WHERE client_id = ${clientId};`,
    `DELETE FROM memberships WHERE client_id = ${clientId};`,
    `DELETE FROM audit_events WHERE client_id = ${clientId};`,
    `DELETE FROM clients WHERE id = ${clientId};`,
  );
}

const clientId = randomUUID();
statements.push(
  `INSERT INTO clients (id, name, billing_email, status, created_at, updated_at)
    VALUES (${sqlString(clientId)}, ${sqlString(clientName)}, ${sqlString('billing@example.com')}, 'active', ${now}, ${now});`,
);

const membershipId = randomUUID();
statements.push(
  `INSERT INTO memberships (id, client_id, email, role, status, created_at, updated_at)
    VALUES (${sqlString(membershipId)}, ${sqlString(clientId)}, ${sqlString(email)}, 'owner', 'invited', ${now}, ${now});`,
);

statements.push(
  insertService({
    id: randomUUID(),
    clientId,
    name: 'Managed IT Support',
    description: 'Help desk and endpoint management.',
    startedAt: now - 120 * day,
  }),
  insertService({
    id: randomUUID(),
    clientId,
    name: 'Cloud Backup',
    description: 'Nightly offsite backup and retention.',
    startedAt: now - 60 * day,
  }),
);

const invoiceOpenId = randomUUID();
statements.push(
  insertInvoice({
    id: invoiceOpenId,
    clientId,
    number: 'MON-00001',
    status: 'open',
    totalCents: 42500,
    description: 'Network Infrastructure Services',
    issuedAt: now - 5 * day,
    dueAt: now + 25 * day,
  }),
  insertInvoiceItem({ id: randomUUID(), invoiceId: invoiceOpenId, position: 1, description: 'Firewall appliance setup', quantity: 1, unitCents: 27500 }),
  insertInvoiceItem({ id: randomUUID(), invoiceId: invoiceOpenId, position: 2, description: 'Network cabling', quantity: 1, unitCents: 15000 }),
);

const invoicePaidId = randomUUID();
statements.push(
  insertInvoice({
    id: invoicePaidId,
    clientId,
    number: 'MON-00002',
    status: 'paid',
    totalCents: 15000,
    description: 'Monthly Service Retainer',
    issuedAt: now - 40 * day,
    dueAt: now - 10 * day,
    paidAt: now - 12 * day,
  }),
  insertInvoiceItem({ id: randomUUID(), invoiceId: invoicePaidId, position: 1, description: 'Monthly service retainer', quantity: 1, unitCents: 15000 }),
);

const invoiceDraftId = randomUUID();
statements.push(
  insertInvoice({
    id: invoiceDraftId,
    clientId,
    number: 'MON-00003',
    status: 'draft',
    totalCents: 9500,
    description: 'Additional Services (Draft)',
  }),
  insertInvoiceItem({ id: randomUUID(), invoiceId: invoiceDraftId, position: 1, description: 'Additional services', quantity: 1, unitCents: 9500 }),
);

const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
const paymentLinkId = randomUUID();
statements.push(
  `INSERT INTO payment_links (id, invoice_id, token_hash, status, created_at)
    VALUES (${sqlString(paymentLinkId)}, ${sqlString(invoiceOpenId)}, ${sqlString(tokenHash)}, 'active', ${now});`,
);

const tempDir = mkdtempSync(join(tmpdir(), 'monolith-seed-'));
const sqlPath = join(tempDir, 'seed.sql');
try {
  writeFileSync(sqlPath, statements.join('\n'), 'utf8');
  runWranglerFile(sqlPath);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`Seeded "${clientName}" with invoices MON-00001 (open), MON-00002 (paid), MON-00003 (draft).`);
console.log(`Invited email: ${email}`);
if (staging) {
  console.log(`Seeded into remote staging D1 (${databaseName}). Token: ${token}`);
} else {
  console.log(`Pay URL: http://pay.localhost:8788/i/${token}`);
}
