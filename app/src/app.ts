import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from './deps.ts';
import { payHeaders, portalHeaders } from './http/headers.ts';
import { createPayRoutes } from './http/pay.ts';
import { createPortalApi } from './http/portal-api.ts';
import { stripeWebhookHandler } from './http/webhook.ts';
import { notFoundPage } from './pay/render.ts';

function applyHeaders(headers: Record<string, string>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // The response may come from a binding (e.g. Cloudflare's ASSETS) whose headers are immutable,
    // so rebuild the response instead of mutating c.res.headers in place.
    const responseHeaders = new Headers(c.res.headers);
    // A route that already set one of these (e.g. /pay.css caching its own Cache-Control) keeps
    // its value; every other response gets the host's default.
    for (const [key, value] of Object.entries(headers)) {
      if (!responseHeaders.has(key)) responseHeaders.set(key, value);
    }
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers: responseHeaders,
    });
  };
}

function createPayApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', applyHeaders(payHeaders()));
  app.get('/healthz', c => c.json({ status: 'ok' }));
  app.post('/api/stripe/webhook', stripeWebhookHandler(deps));
  app.route('/', createPayRoutes(deps));
  // Every other path on this host (including the retired token-bearing return routes) gets the same
  // branded HTML 404 the invoice routes render, never a bare JSON error. The webhook keeps its own
  // JSON responses; it is a real, matched route above, so this never applies to it. A path under
  // /i/ or /checkout/ still gets the payment-link copy; anything else (e.g. /robots.txt) gets the
  // generic variant, since no link was necessarily involved.
  app.notFound(c => {
    const path = c.req.path;
    const generic = !path.startsWith('/i/') && !path.startsWith('/checkout/');
    return c.body(notFoundPage(generic ? 'generic' : 'invoice-link'), 404, { 'Content-Type': 'text/html; charset=utf-8' });
  });
  return app;
}

function createPortalApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', applyHeaders(portalHeaders(deps.clerkFrontendApiUrl)));
  // Every /api/* response is tenant-scoped billing data (or the public config / reserved webhook
  // stub next to it). Registered before any /api route is added below, so no-store covers all of
  // them no matter what order those routes are registered in.
  app.use('/api/*', applyHeaders({ 'Cache-Control': 'no-store' }));
  app.get('/healthz', c => c.json({ status: 'ok' }));
  app.get('/api/public-config', c => c.json({ clerkPublishableKey: deps.clerkPublishableKey }));
  // The Stripe webhook is a pay-host route; reserving the path here keeps the portal's answer a plain
  // 404 instead of the 401 that requireClient would give every unknown /api path.
  app.all('/api/stripe/webhook', c => c.json({ error: 'not_found' }, 404));
  // Registered after public-config, so that one public route still answers before requireClient.
  app.route('/api', createPortalApi(deps));
  app.notFound(c => {
    if (!c.req.path.startsWith('/api/') && deps.assets) return deps.assets.fetch(c.req.raw);
    return c.json({ error: 'not_found' }, 404);
  });
  return app;
}

// The unknown-host 404 is built outside both Hono apps, so it applies the header set itself: no
// response leaves the Worker without one. The pay set is the stricter of the two.
function unknownHostResponse(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...payHeaders() },
  });
}

export function createApp(deps: AppDeps): { fetch(request: Request): Promise<Response> } {
  const payApp = createPayApp(deps);
  const portalApp = createPortalApp(deps);
  return {
    async fetch(request: Request): Promise<Response> {
      const hostname = new URL(request.url).hostname.toLowerCase();
      if (hostname === deps.hosts.pay.toLowerCase()) return payApp.fetch(request);
      if (hostname === deps.hosts.portal.toLowerCase()) return portalApp.fetch(request);
      return unknownHostResponse();
    },
  };
}
