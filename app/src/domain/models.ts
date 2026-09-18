// Domain types mirroring the D1 schema (camelCase fields). See app/migrations/0001_app.sql.

export type InvoiceStatus = 'draft' | 'open' | 'processing' | 'paid' | 'void';
export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface Client {
  id: string;
  name: string;
  billingEmail: string;
  status: 'active' | 'inactive';
  stripeCustomerId: string | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Membership {
  id: string;
  clientId: string;
  email: string;
  clerkUserId: string | null;
  role: 'owner' | 'member';
  status: 'invited' | 'active' | 'revoked';
  boundAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Service {
  id: string;
  clientId: string;
  name: string;
  description: string;
  status: 'active' | 'ended';
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Invoice {
  id: string;
  clientId: string;
  number: string;
  status: InvoiceStatus;
  currency: string;
  totalCents: number;
  description: string;
  issuedAt: number | null;
  dueAt: number | null;
  paidAt: number | null;
  voidedAt: number | null;
  externalSource: string | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  position: number;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface PaymentLink {
  id: string;
  invoiceId: string;
  tokenHash: string;
  status: 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface Payment {
  id: string;
  invoiceId: string;
  clientId: string;
  paymentLinkId: string | null;
  source: 'payment_link' | 'portal';
  stripeCheckoutSessionId: string;
  stripePaymentIntentId: string | null;
  checkoutUrl: string | null;
  amountCents: number;
  currency: string;
  method: string | null;
  status: PaymentStatus;
  sessionExpiresAt: number;
  createdAt: number;
  updatedAt: number;
  succeededAt: number | null;
  failedAt: number | null;
}

export interface PaymentEvent {
  id: string;
  stripeEventId: string;
  type: string;
  livemode: boolean;
  paymentId: string | null;
  invoiceId: string | null;
  outcome: 'applied' | 'ignored' | 'unmatched' | 'mismatch';
  payloadJson: string;
  receivedAt: number;
}

export interface AuditEvent {
  id: string;
  occurredAt: number;
  actorType: 'system' | 'client_user' | 'staff' | 'stripe';
  actorId: string | null;
  clientId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  detailsJson: string | null;
}
