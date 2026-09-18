import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { resolveMembership } from '../src/auth/membership.ts';
import { newId } from '../src/domain/ids.ts';
import { outstandingBalanceCents } from '../src/domain/invoices.ts';
import { testDeps, portalUrl, FakeSessions, FakeClerkUsers } from './helpers/app.ts';
import { seedClient, seedInvoice } from './helpers/fixtures.ts';
import type { AppDeps } from '../src/deps.ts';
import type { Client } from '../src/domain/models.ts';

function setup() {
  const sessions = new FakeSessions();
  const clerkUsers = new FakeClerkUsers();
  const deps = testDeps({ sessions, clerkUsers });
  return { deps, sessions, clerkUsers, app: createApp(deps) };
}

function get(app: { fetch(request: Request): Promise<Response> }, path: string, token?: string): Promise<Response> {
  const headers = token === undefined ? undefined : { Authorization: `Bearer ${token}` };
  return app.fetch(new Request(portalUrl(path), { headers }));
}

async function seedMembership(
  db: D1Database,
  now: () => number,
  input: {
    clientId: string;
    email: string;
    status?: 'invited' | 'active' | 'revoked';
    role?: 'owner' | 'member';
    clerkUserId?: string;
  },
): Promise<string> {
  const id = newId();
  const at = now();
  await db
    .prepare(`INSERT INTO memberships (id, client_id, email, clerk_user_id, role, status, bound_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      input.clientId,
      input.email,
      input.clerkUserId ?? null,
      input.role ?? 'owner',
      input.status ?? 'invited',
      input.clerkUserId ? at : null,
      at,
      at,
    )
    .run();
  return id;
}

async function seedService(db: D1Database, now: () => number, clientId: string, name: string): Promise<string> {
  const id = newId();
  const at = now();
  await db
    .prepare(`INSERT INTO services (id, client_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, clientId, name, `${name} for this client`, at, at)
    .run();
  return id;
}

// An account that already finished first-login binding, for the tests about client scoping.
async function seedBoundAccount(
  deps: AppDeps,
  sessions: FakeSessions,
  options: { token: string; userId: string; name?: string },
): Promise<Client> {
  const client = await seedClient(deps.db, deps.now, { name: options.name });
  await seedMembership(deps.db, deps.now, {
    clientId: client.id,
    email: `${options.userId}@example.com`,
    status: 'active',
    clerkUserId: options.userId,
  });
  sessions.set(options.token, options.userId);
  return client;
}

test('a portal API request without an Authorization header is unauthenticated', async () => {
  const { app } = setup();
  const response = await get(app, '/api/me');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthenticated' });
});

test('a token the session verifier rejects is unauthenticated', async () => {
  const { app } = setup();
  const response = await get(app, '/api/me', 'bad');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthenticated' });
});

test('an authenticated user with no membership gets no_account', async () => {
  const { app, sessions, clerkUsers } = setup();
  sessions.set('token', 'user_9');
  clerkUsers.set('user_9', 'nobody@example.com');
  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'no_account' });
});

test('first login binds the invited membership and audits it', async () => {
  const { app, deps, sessions, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now, { name: 'Alex Industries' });
  const membershipId = await seedMembership(deps.db, deps.now, { clientId: client.id, email: 'alex@example.com' });
  sessions.set('token', 'user_1');
  clerkUsers.set('user_1', 'alex@example.com');

  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.user.id, 'user_1');
  assert.equal(body.client.id, client.id);
  assert.equal(body.client.name, 'Alex Industries');
  assert.equal(body.membership.id, membershipId);
  assert.equal(body.membership.role, 'owner');
  assert.equal(body.membership.status, 'active');

  const row = await deps.db
    .prepare('SELECT clerk_user_id, status, bound_at FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<{ clerk_user_id: string | null; status: string; bound_at: number | null }>();
  assert.equal(row?.clerk_user_id, 'user_1');
  assert.equal(row?.status, 'active');
  assert.equal(row?.bound_at, deps.now());

  const audit = await deps.db
    .prepare(`SELECT * FROM audit_events WHERE action = 'membership.bound'`)
    .all<{ actor_type: string; actor_id: string | null; client_id: string | null; entity_type: string; entity_id: string }>();
  assert.equal(audit.results.length, 1);
  assert.equal(audit.results[0].actor_type, 'client_user');
  assert.equal(audit.results[0].actor_id, 'user_1');
  assert.equal(audit.results[0].client_id, client.id);
  assert.equal(audit.results[0].entity_type, 'membership');
  assert.equal(audit.results[0].entity_id, membershipId);
});

test('a bound membership is not looked up in Clerk again on the next request', async () => {
  const { app, deps, sessions, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now);
  await seedMembership(deps.db, deps.now, { clientId: client.id, email: 'alex@example.com' });
  sessions.set('token', 'user_1');
  clerkUsers.set('user_1', 'alex@example.com');

  assert.equal((await get(app, '/api/me', 'token')).status, 200);
  assert.equal(clerkUsers.calls, 1);
  assert.equal((await get(app, '/api/me', 'token')).status, 200);
  assert.equal(clerkUsers.calls, 1);
});

test('membership binding matches the email case-insensitively', async () => {
  const { app, deps, sessions, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now);
  const membershipId = await seedMembership(deps.db, deps.now, { clientId: client.id, email: 'alex@example.com' });
  sessions.set('token', 'user_1');
  clerkUsers.set('user_1', 'Alex@Example.com');

  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).membership.id, membershipId);
});

test('concurrent first logins both resolve the one invited membership', async () => {
  const { deps, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now, { name: 'Alex Industries' });
  const membershipId = await seedMembership(deps.db, deps.now, { clientId: client.id, email: 'alex@example.com' });
  clerkUsers.set('user_1', 'alex@example.com');

  // The loser of the race sees changes = 0 because the other request just bound the row, not because
  // no invited row exists. It must still resolve instead of turning into a 403 no_account.
  const [first, second] = await Promise.all([
    resolveMembership(deps.db, deps, 'user_1'),
    resolveMembership(deps.db, deps, 'user_1'),
  ]);
  assert.equal(first?.membership.id, membershipId);
  assert.equal(second?.membership.id, membershipId);

  const audit = await deps.db
    .prepare(`SELECT id FROM audit_events WHERE action = 'membership.bound'`)
    .all<{ id: string }>();
  assert.equal(audit.results.length, 1);
});

test('an unverified Clerk email never binds a membership', async () => {
  const { app, deps, sessions, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now);
  const membershipId = await seedMembership(deps.db, deps.now, { clientId: client.id, email: 'alex@example.com' });
  sessions.set('token', 'user_1');
  clerkUsers.set('user_1', null);

  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'no_account' });

  const row = await deps.db
    .prepare('SELECT clerk_user_id, status FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<{ clerk_user_id: string | null; status: string }>();
  assert.equal(row?.clerk_user_id, null);
  assert.equal(row?.status, 'invited');
});

test('a revoked membership is refused and never re-bound', async () => {
  const { app, deps, sessions, clerkUsers } = setup();
  const client = await seedClient(deps.db, deps.now);
  const membershipId = await seedMembership(deps.db, deps.now, {
    clientId: client.id,
    email: 'alex@example.com',
    status: 'revoked',
    clerkUserId: 'user_1',
  });
  sessions.set('token', 'user_1');
  clerkUsers.set('user_1', 'alex@example.com');

  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'no_account' });

  const row = await deps.db
    .prepare('SELECT status FROM memberships WHERE id = ?')
    .bind(membershipId)
    .first<{ status: string }>();
  assert.equal(row?.status, 'revoked');
});

test('balanceCents in /api/me is the outstanding balance', async () => {
  const { app, deps, sessions } = setup();
  const client = await seedBoundAccount(deps, sessions, { token: 'token', userId: 'user_1' });
  await seedInvoice(deps.db, deps.now, client.id, { items: [{ description: 'A', quantity: 1, unitCents: 10000 }] });
  await seedInvoice(deps.db, deps.now, client.id, { items: [{ description: 'B', quantity: 2, unitCents: 2500 }] });
  await seedInvoice(deps.db, deps.now, client.id, {
    status: 'draft',
    items: [{ description: 'C', quantity: 1, unitCents: 9900 }],
  });

  const response = await get(app, '/api/me', 'token');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.balanceCents, 15000);
  assert.equal(body.balanceCents, await outstandingBalanceCents(deps.db, client.id));
});

test('a client can read its own client record', async () => {
  const { app, deps, sessions } = setup();
  const client = await seedBoundAccount(deps, sessions, { token: 'token', userId: 'user_1', name: 'Mine Ltd' });

  const response = await get(app, `/api/clients/${client.id}`, 'token');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: client.id, name: 'Mine Ltd', billingEmail: client.billingEmail });
});

test('the record of another client is not found', async () => {
  const { app, deps, sessions } = setup();
  const mine = await seedBoundAccount(deps, sessions, { token: 'token', userId: 'user_1', name: 'Mine Ltd' });
  const other = await seedClient(deps.db, deps.now, { name: 'Other Ltd' });
  // Guard: the route has to exist, so the 404 below cannot come from the catch-all.
  assert.equal((await get(app, `/api/clients/${mine.id}`, 'token')).status, 200);

  const response = await get(app, `/api/clients/${other.id}`, 'token');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('services list only the services of the caller client', async () => {
  const { app, deps, sessions } = setup();
  const client = await seedBoundAccount(deps, sessions, { token: 'token', userId: 'user_1', name: 'Mine Ltd' });
  const other = await seedClient(deps.db, deps.now, { name: 'Other Ltd' });
  await seedService(deps.db, deps.now, client.id, 'Managed backups');
  await seedService(deps.db, deps.now, other.id, 'Other service');

  const response = await get(app, '/api/services', 'token');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.services.map((service: { name: string }) => service.name), ['Managed backups']);
  assert.equal(body.services[0].status, 'active');
});
