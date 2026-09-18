import { createApp } from './app.ts';
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
}

// Tasks 3/4 replace these with real Clerk and Stripe adapters.
function notConfigured(): never {
  throw new Error('not configured');
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
    sessions: { verify: async () => notConfigured() },
    clerkUsers: { primaryVerifiedEmail: async () => notConfigured() },
    stripe: { createCheckoutSession: async () => notConfigured() },
    webhooks: { verify: async () => notConfigured() },
    now: () => Math.floor(Date.now() / 1000),
    randomBytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    logError: (event: string, error: unknown) => {
      console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : 'unknown' }));
    },
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return createApp(toDeps(env)).fetch(request);
  },
};
