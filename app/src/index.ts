import { createApp } from './app.ts';
import { clerkSessionVerifier, clerkUsersClient } from './auth/clerk.ts';
import type { AppDeps, Hosts } from './deps.ts';

export interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  PAY_HOST: string;
  PORTAL_HOST: string;
  ADMIN_HOST: string;
  STRIPE_MODE: 'test' | 'live';
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_FRONTEND_API_URL: string;
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY: string;
}

// Task 4 replaces these with the real Stripe adapters.
function notConfigured(): never {
  throw new Error('not configured');
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : 'unknown' }));
}

// The origins a session JWT may have been issued for; locally the Vite dev server proxies to 8788.
function authorizedParties(portalHost: string): string[] {
  const origins = [`https://${portalHost}`];
  if (portalHost === 'localhost') origins.push('http://localhost:8788');
  return origins;
}

function toDeps(env: Env): AppDeps {
  const hosts: Hosts = { pay: env.PAY_HOST, portal: env.PORTAL_HOST, admin: env.ADMIN_HOST };
  return {
    db: env.DB,
    assets: env.ASSETS,
    hosts,
    stripeMode: env.STRIPE_MODE,
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
    clerkFrontendApiUrl: env.CLERK_FRONTEND_API_URL,
    sessions: clerkSessionVerifier({
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: authorizedParties(env.PORTAL_HOST),
      logError,
    }),
    clerkUsers: clerkUsersClient({ secretKey: env.CLERK_SECRET_KEY }),
    stripe: { createCheckoutSession: async () => notConfigured() },
    webhooks: { verify: async () => notConfigured() },
    now: () => Math.floor(Date.now() / 1000),
    randomBytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    logError,
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return createApp(toDeps(env)).fetch(request);
  },
};
