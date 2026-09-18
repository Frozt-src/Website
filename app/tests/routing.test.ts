import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { testDeps, payUrl, portalUrl } from './helpers/app.ts';

const payCsp = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";

test('an unknown host returns a generic 404 that still carries the security headers', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request('https://unknown.test/healthz'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  // No response leaves the Worker without headers, including the one built outside both Hono apps.
  assert.equal(response.headers.get('Content-Security-Policy'), payCsp);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('the reserved admin host returns 404', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request('https://admin.test/healthz'));
  assert.equal(response.status, 404);
});

test('pay healthz responds ok with the exact pay CSP and no-store cache', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request(payUrl('/healthz')));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('Content-Security-Policy'), payCsp);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('portal healthz responds ok with a Clerk-aware CSP and HSTS', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request(portalUrl('/healthz')));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.ok(response.headers.get('Content-Security-Policy')?.includes("script-src 'self' https://fake.clerk.accounts.dev"));
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
});

test('portal public-config exposes the publishable key', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request(portalUrl('/api/public-config')));
  assert.deepEqual(await response.json(), { clerkPublishableKey: 'pk_test_fake' });
});

test('portal public-config is never cacheable', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request(portalUrl('/api/public-config')));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('the reserved stripe webhook 404 on the portal host is never cacheable', async () => {
  const app = createApp(testDeps());
  const response = await app.fetch(new Request(portalUrl('/api/stripe/webhook'), { method: 'POST' }));
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('portal serves static assets for non-api paths', async () => {
  const assetBody = 'portal shell';
  const assets = { fetch: async () => new Response(assetBody, { status: 200 }) };
  const app = createApp(testDeps({ assets }));
  const response = await app.fetch(new Request(portalUrl('/anything')));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), assetBody);
});

test('the pay host never serves static assets', async () => {
  const assets = { fetch: async () => new Response('should not be served') };
  const app = createApp(testDeps({ assets }));
  const response = await app.fetch(new Request(payUrl('/index.html')));
  assert.equal(response.status, 404);
});

test('portal still applies security headers when the asset response has immutable headers', async () => {
  // The real Cloudflare ASSETS binding returns Responses whose headers throw on mutation, unlike
  // the plain mutable Response the other fakes here return.
  const assetBody = 'portal shell';
  const assets = {
    fetch: async () => {
      const res = new Response(assetBody, { status: 200 });
      Object.defineProperty(res.headers, 'set', {
        value() {
          throw new TypeError("Can't modify immutable headers");
        },
      });
      return res;
    },
  };
  const app = createApp(testDeps({ assets }));
  const response = await app.fetch(new Request(portalUrl('/anything')));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), assetBody);
  assert.ok(response.headers.get('Content-Security-Policy')?.includes("script-src 'self' https://fake.clerk.accounts.dev"));
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
});
