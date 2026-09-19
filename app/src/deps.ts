// Everything the Worker needs from the outside world, so tests can inject fakes.
export interface Hosts { pay: string; portal: string; admin: string }

export interface SessionVerifier {
  // Resolves the Clerk user id for a valid session JWT, or null when invalid/expired.
  verify(token: string): Promise<{ userId: string } | null>;
}
export interface ClerkUsers {
  // Primary email address if it is verified, else null. Only used at first login.
  primaryVerifiedEmail(userId: string): Promise<string | null>;
}
export interface CheckoutSessionInput {
  idempotencyKey: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  description: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: number; // unix seconds
}
export interface StripeGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string }>;
  // Closes a session we are replacing, so only one live session per invoice exists at Stripe.
  expireCheckoutSession(sessionId: string): Promise<void>;
}
export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}
export interface WebhookVerifier {
  // Throws on an invalid signature.
  verify(payload: string, signatureHeader: string): Promise<StripeEvent>;
}

export interface AppDeps {
  db: D1Database;
  assets?: { fetch(request: Request): Promise<Response> };
  hosts: Hosts;
  stripeMode: 'test' | 'live';
  clerkPublishableKey: string;
  clerkFrontendApiUrl: string;
  sessions: SessionVerifier;
  clerkUsers: ClerkUsers;
  stripe: StripeGateway;
  webhooks: WebhookVerifier;
  now(): number; // unix seconds
  sleep(ms: number): Promise<void>; // only used to wait out a checkout claim another request won
  randomBytes(length: number): Uint8Array;
  logError(event: string, error: unknown): void; // never logs personal data or tokens
}
