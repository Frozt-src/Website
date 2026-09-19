// Gated integration test: a real Clerk development instance against a locally running Worker.
// Skips with a printed reason when app/.dev.vars has no CLERK_SECRET_KEY or no Worker answers on
// 8788. Never part of `npm test` — see app/tests/integration/README.md for the runbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createClerkClient } from '@clerk/backend';
import type { User } from '@clerk/backend';
import { harness, manualSkip, repoRoot, skip } from './env.ts';
import { d1, sqlString, waitFor } from './local-d1.ts';

interface MembershipRow {
  id: string;
  email: string;
  clerk_user_id: string | null;
  status: string;
}

// `+clerk_test` addresses are Clerk's documented development-instance test addresses. The third
// one deliberately is not one: its email is left unverified, which no test address may be.
const boundEmail = 'bound+clerk_test@example.com';
const strangerEmail = 'nobody+clerk_test@example.com';
const unverifiedEmail = 'unverified@example.com';
const ticketLifetimeSeconds = 600;
// The controller has to open three urls in a browser, so the wait is generous.
const manualTimeoutMs = 5 * 60 * 1000;

const clerk = createClerkClient({ secretKey: harness.clerkSecretKey });

let users: { bound: User; stranger: User; unverified: User };
let membershipId: string;

async function ensureUser(email: string, verified: boolean): Promise<User> {
  const existing = await clerk.users.getUserList({ emailAddress: [email], limit: 1 });
  const user = existing.data[0] ?? (await clerk.users.createUser({ emailAddress: [email], skipPasswordRequirement: true }));
  const address = user.emailAddresses.find(candidate => candidate.emailAddress.toLowerCase() === email.toLowerCase());
  assert.ok(address, `Clerk user ${user.id} has no ${email} address`);
  if ((address.verification?.status === 'verified') !== verified) {
    await clerk.emailAddresses.updateEmailAddress(address.id, { verified });
  }
  return clerk.users.getUser(user.id);
}

async function ticketUrl(user: User): Promise<string> {
  const ticket = await clerk.signInTokens.createSignInToken({ userId: user.id, expiresInSeconds: ticketLifetimeSeconds });
  return `http://localhost:8788/?__clerk_ticket=${ticket.token}`;
}

function membership(): MembershipRow | null {
  return d1<MembershipRow>(`SELECT * FROM memberships WHERE id = ${sqlString(membershipId)}`)[0] ?? null;
}

function assertBound(userId: string): void {
  const row = membership();
  assert.ok(row, 'the seeded membership row is gone');
  assert.equal(row.status, 'active');
  assert.equal(row.clerk_user_id, userId);
  const audit = d1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE action = 'membership.bound' AND entity_id = ${sqlString(membershipId)}`,
  );
  assert.equal(audit[0]?.n, 1);
}

// The Backend API can mint a session JWT, but the Worker verifies it against an
// `authorizedParties` list and a backend-minted token does not carry a matching `azp` claim on
// every instance. When the Worker refuses it, the browser tickets are the only way in.
async function meAs(user: User): Promise<{ status: number; body: string }> {
  const session = await clerk.sessions.createSession({ userId: user.id });
  const token = await clerk.sessions.getToken(session.id);
  return harness.portal('/api/me', { headers: { authorization: `Bearer ${token.jwt}` } });
}

test('the three development users exist and their sign-in tickets are printed', { skip }, async () => {
  users = {
    bound: await ensureUser(boundEmail, true),
    stranger: await ensureUser(strangerEmail, true),
    unverified: await ensureUser(unverifiedEmail, false),
  };

  const unverifiedAddress = users.unverified.emailAddresses.find(
    address => address.emailAddress.toLowerCase() === unverifiedEmail,
  );
  assert.notEqual(unverifiedAddress?.verification?.status, 'verified');

  console.log(`\n  bound, expect the portal to load:        ${await ticketUrl(users.bound)}`);
  console.log(`  no membership, expect 403 no_account:    ${await ticketUrl(users.stranger)}`);
  console.log(`  unverified email, expect 403 no_account: ${await ticketUrl(users.unverified)}`);
  console.log(`  tickets expire in ${ticketLifetimeSeconds} seconds.\n`);
});

test('the local database holds an invited membership for the bound user', { skip }, async () => {
  const stdout = execFileSync(
    process.execPath,
    [join(repoRoot, 'app/scripts/seed-dev.mjs'), '--reset', '--json', '--email', boundEmail],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  membershipId = (JSON.parse(stdout.trim()) as { membershipId: string }).membershipId;

  const row = membership();
  assert.ok(row);
  assert.equal(row.email, boundEmail);
  assert.equal(row.status, 'invited');
  assert.equal(row.clerk_user_id, null);
});

test('opening the bound ticket in a browser binds the membership', { skip: manualSkip }, async () => {
  console.log('\n  MANUAL STEP: open the three ticket urls printed above, in a browser.');
  console.log('  Verification codes for +clerk_test addresses are always 424242.');
  console.log(`  ${boundEmail} should reach the portal; the other two should see the no-account screen`);
  console.log('  (their GET /api/me answers 403 {"error":"no_account"}).\n');

  await waitFor({
    label: `the membership for ${boundEmail} to become active`,
    timeoutMs: manualTimeoutMs,
    probe: () => {
      const row = membership();
      return row?.status === 'active' && row.clerk_user_id ? row.clerk_user_id : null;
    },
  });
  assertBound(users.bound.id);
});

test('a Backend-API session JWT reaches the portal API as the bound user only', { skip }, async t => {
  let bound;
  try {
    bound = await meAs(users.bound);
  } catch (error) {
    // The instance does not let the Backend API create a session at all.
    t.skip(`this Clerk instance mints no Backend-API session (${error instanceof Error ? error.message : 'unknown error'}) — use the browser tickets`);
    return;
  }
  if (bound.status === 401) {
    // Not a failure of the Worker: this instance's session tokens do not satisfy the
    // `authorizedParties` check, so only the browser tickets can exercise these paths.
    t.skip('this Clerk instance mints session JWTs the Worker refuses (no matching azp claim) — use the browser tickets');
    return;
  }

  assert.equal(bound.status, 200);
  const me = JSON.parse(bound.body) as { user: { id: string }; membership: { id: string } };
  assert.equal(me.user.id, users.bound.id);
  assert.equal(me.membership.id, membershipId);
  assertBound(users.bound.id);

  const stranger = await meAs(users.stranger);
  assert.equal(stranger.status, 403);
  assert.deepEqual(JSON.parse(stranger.body), { error: 'no_account' });

  const unverified = await meAs(users.unverified);
  assert.equal(unverified.status, 403);
  assert.deepEqual(JSON.parse(unverified.body), { error: 'no_account' });
});
