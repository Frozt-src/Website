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
  // Stripe refuses to expire a session that has already completed. Tests flip this to exercise that.
  expireShouldThrow = false;
  private counter = 0;
  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }> {
    this.calls.push(input);
    this.counter++;
    // Shaped like a real Stripe id, so tests exercise the session-id validation the return routes do.
    const id = `cs_test_${String(this.counter).padStart(8, '0')}`;
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  }
  async expireCheckoutSession(sessionId: string): Promise<void> {
    if (this.expireShouldThrow) throw new Error('stripe refused to expire the session');
    this.expired.push(sessionId);
  }
}

// A gateway that hangs inside createCheckoutSession until the test releases it, so a concurrent
// checkout is guaranteed to arrive while the first one is still waiting on Stripe.
export class DeferredStripe extends FakeStripe {
  private readonly released: Promise<void>;
  // Resolves the moment the gateway is first called, so the test can act at that exact point.
  readonly calledOnce: Promise<void>;
  private release = () => {};
  private called = () => {};
  constructor() {
    super();
    this.released = new Promise<void>(resolve => { this.release = resolve; });
    this.calledOnce = new Promise<void>(resolve => { this.called = resolve; });
  }
  override async createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }> {
    this.called();
    await this.released;
    return super.createCheckoutSession(input);
  }
  resume(): void {
    this.release();
  }
}

// Zero delay, but a real macrotask: everything already queued runs to completion before the sleeper
// looks again, which is what makes the concurrent checkout test deterministic.
export class FakeSleep {
  calls: number[] = [];
  sleep = async (ms: number): Promise<void> => {
    this.calls.push(ms);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
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
    sleep: new FakeSleep().sleep,
    randomBytes: (length: number) => {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = seed++ % 256;
      return bytes;
    },
    logError: () => {},
  };
  return { ...base, ...overrides };
}
