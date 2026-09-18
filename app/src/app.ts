import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { AppDeps } from './deps.ts';
import { payHeaders, portalHeaders } from './http/headers.ts';
import { createPortalApi } from './http/portal-api.ts';

function applyHeaders(headers: Record<string, string>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [key, value] of Object.entries(headers)) c.res.headers.set(key, value);
  };
}

function createPayApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', applyHeaders(payHeaders()));
  app.get('/healthz', c => c.json({ status: 'ok' }));
  app.notFound(c => c.json({ error: 'not_found' }, 404));
  return app;
}

function createPortalApp(deps: AppDeps) {
  const app = new Hono();
  app.use('*', applyHeaders(portalHeaders(deps.clerkFrontendApiUrl)));
  app.get('/healthz', c => c.json({ status: 'ok' }));
  app.get('/api/public-config', c => c.json({ clerkPublishableKey: deps.clerkPublishableKey }));
  // Registered after public-config, so that one public route still answers before requireClient.
  app.route('/api', createPortalApi(deps));
  app.notFound(c => {
    if (!c.req.path.startsWith('/api/') && deps.assets) return deps.assets.fetch(c.req.raw);
    return c.json({ error: 'not_found' }, 404);
  });
  return app;
}

export function createApp(deps: AppDeps): { fetch(request: Request): Promise<Response> } {
  const payApp = createPayApp(deps);
  const portalApp = createPortalApp(deps);
  return {
    async fetch(request: Request): Promise<Response> {
      const hostname = new URL(request.url).hostname.toLowerCase();
      if (hostname === deps.hosts.pay.toLowerCase()) return payApp.fetch(request);
      if (hostname === deps.hosts.portal.toLowerCase()) return portalApp.fetch(request);
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    },
  };
}
