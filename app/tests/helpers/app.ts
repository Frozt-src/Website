// Fakes for every external dependency in AppDeps, so tests never touch real Clerk or Stripe.
import { database } from './d1.ts';
import type {
  AppDeps,
  SessionVerifier,
  ClerkUsers,
  StripeGateway,
  CheckoutSessionInput,
  WebhookVerifier,
  StripeEvent,
} from '../../src/deps.ts';

export function payUrl(path: string): string {
  return `https://pay.test${path}`;
}
export function portalUrl(path: string): string {
  return `https://portal.test${path}`;
}

export class FakeSessions implements SessionVerifier {
  private users = new Map<string, string>();
  set(token: string, userId: string): void {
    this.users.set(token, userId);
  }
  async verify(token: string): Promise<{ userId: string } | null> {
    const userId = this.users.get(token);
    return userId ? { userId } : null;
  }
}

export class FakeClerkUsers implements ClerkUsers {
  calls = 0;
  private emails = new Map<string, string | null>();
  set(userId: string, email: string | null): void {
    this.emails.set(userId, email);
  }
  async primaryVerifiedEmail(userId: string): Promise<string | null> {
    this.calls++;
    return this.emails.get(userId) ?? null;
  }
}

export class FakeStripe implements StripeGateway {
  calls: CheckoutSessionInput[] = [];
  expired: string[] = [];
  private counter = 0;
  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }> {
    this.calls.push(input);
    this.counter++;
    // Shaped like a real Stripe id, so tests exercise the session-id validation the return routes do.
    const id = `cs_test_${String(this.counter).padStart(8, '0')}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }
  async expireCheckoutSession(sessionId: string): Promise<void> {
    this.expired.push(sessionId);
  }
}

export class FakeWebhooks implements WebhookVerifier {
  async verify(payload: string, signatureHeader: string): Promise<StripeEvent> {
    if (signatureHeader !== 'valid') throw new Error('invalid signature');
    return JSON.parse(payload) as StripeEvent;
  }
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const { db } = database();
  let clock = 1_700_000_000;
  let seed = 0;
  const base: AppDeps = {
    db,
    hosts: { pay: 'pay.test', portal: 'portal.test', admin: 'admin.test' },
    stripeMode: 'test',
    clerkPublishableKey: 'pk_test_fake',
    clerkFrontendApiUrl: 'https://fake.clerk.accounts.dev',
    sessions: new FakeSessions(),
    clerkUsers: new FakeClerkUsers(),
    stripe: new FakeStripe(),
    webhooks: new FakeWebhooks(),
    now: () => clock,
    randomBytes: (length: number) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = seed++ % 256;
      return bytes;
    },
    logError: () => {},
  };
  return { ...base, ...overrides };
}
