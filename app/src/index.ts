import { createApp } from './app.ts';
import { clerkSessionVerifier, clerkUsersClient } from './auth/clerk.ts';
import { stripeGateway } from './stripe/gateway.ts';
import { stripeWebhookVerifier } from './stripe/webhooks.ts';
import type { AppDeps, Hosts, StripeGateway, WebhookVerifier } from './deps.ts';

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
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

function configured(value: string | undefined): boolean {
  return typeof value === 'string' && value !== '';
}

// Without Stripe credentials the Worker still serves everything else; only paying is unavailable.
function stripeFor(env: Env): StripeGateway {
  if (configured(env.STRIPE_SECRET_KEY)) return stripeGateway(env.STRIPE_SECRET_KEY);
  const notConfigured = () => Object.assign(new Error('stripe is not configured'), { code: 'stripe_not_configured' });
  return {
    createCheckoutSession: async () => {
      throw notConfigured();
    },
    expireCheckoutSession: async () => {
      throw notConfigured();
    },
  };
}

function webhooksFor(env: Env): WebhookVerifier {
  if (configured(env.STRIPE_WEBHOOK_SECRET)) return stripeWebhookVerifier(env.STRIPE_WEBHOOK_SECRET);
  // Throwing here makes the webhook route answer 400 rather than accept unverified payloads.
  return {
    verify: async () => {
      throw new Error('stripe webhook secret is not configured');
    },
  };
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : 'unknown' }));
}

// The origins a session JWT may have been issued for. Locally that is the Worker itself (8788) and
// the Vite dev server, which serves the portal on 5173 (or 5174 when that port is taken) and only
// proxies /api to the Worker — so the JWT's azp claim is the Vite origin, not the Worker's.
// Exported for the test that pins this list; nothing else imports it.
export function authorizedParties(portalHost: string): string[] {
  const origins = [`https://${portalHost}`];
  if (portalHost === 'localhost') {
    origins.push(
      'http://localhost:8788',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    );
  }
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
    stripe: stripeFor(env),
    webhooks: webhooksFor(env),
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    randomBytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
    logError,
  };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return createApp(toDeps(env)).fetch(request);
  },
};
