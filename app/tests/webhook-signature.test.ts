// Exercises the real Stripe webhook verifier with SDK-generated signatures. No network, no real keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { stripeWebhookVerifier } from '../src/stripe/webhooks.ts';

const secret = 'whsec_test_secret';
const payload = JSON.stringify({
  id: 'evt_test_signature',
  object: 'event',
  type: 'checkout.session.completed',
  livemode: false,
  data: { object: { id: 'cs_test_signature' } },
});

function sign(options: { payload?: string; secret?: string; timestamp?: number } = {}): string {
  return new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({
    payload: options.payload ?? payload,
    secret: options.secret ?? secret,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });
}

test('a payload signed with the webhook secret verifies and parses into the event', async () => {
  const event = await stripeWebhookVerifier(secret).verify(payload, sign());
  assert.equal(event.id, 'evt_test_signature');
  assert.equal(event.type, 'checkout.session.completed');
  assert.equal(event.livemode, false);
  assert.equal((event.data.object as { id: string }).id, 'cs_test_signature');
});

test('a signature produced with a different secret is rejected', async () => {
  await assert.rejects(() => stripeWebhookVerifier(secret).verify(payload, sign({ secret: 'whsec_other_secret' })));
});

test('a payload tampered with after signing is rejected', async () => {
  const header = sign();
  await assert.rejects(() => stripeWebhookVerifier(secret).verify(payload.replace('cs_test_signature', 'cs_test_other'), header));
});

test('a signature older than the five minute tolerance is rejected', async () => {
  const header = sign({ timestamp: Math.floor(Date.now() / 1000) - 600 });
  await assert.rejects(() => stripeWebhookVerifier(secret).verify(payload, header));
});
