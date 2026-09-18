// Data shapes the portal SPA consumes from the portal API (see app/src/http/portal-api.ts) and
// small framework-free helpers shared across App.tsx, auth.tsx, preview.ts and the screens.

export type InvoiceStatus = 'draft' | 'open' | 'processing' | 'paid' | 'void';
export type PaymentStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled';

export interface MeResponse {
  user: { id: string };
  membership: { id: string; role: 'owner' | 'member'; status: 'invited' | 'active' | 'revoked' };
  client: { id: string; name: string; billingEmail: string };
  balanceCents: number;
}

export interface InvoiceSummary {
  id: string;
  number: string;
  status: InvoiceStatus;
  totalCents: number;
  currency: string;
  description: string;
  issuedAt: number | null;
  dueAt: number | null;
  paidAt: number | null;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

export interface InvoicePayment {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  method: string | null;
  createdAt: number;
  succeededAt: number | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  items: InvoiceItem[];
  payments: InvoicePayment[];
}

export interface ServiceSummary {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'ended';
  startedAt: number | null;
  endedAt: number | null;
}

// Thrown by the real (auth.tsx) and preview (preview.ts) API clients alike, so screens can branch
// on `status`/`code` the same way regardless of which client is behind useApi().
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiClient {
  me(): Promise<MeResponse>;
  services(): Promise<ServiceSummary[]>;
  invoices(status?: InvoiceStatus): Promise<InvoiceSummary[]>;
  invoice(id: string): Promise<InvoiceDetail>;
  checkout(id: string): Promise<{ url: string }>;
}

// True only under `npm run app:portal:preview` (`vite --mode preview`). `import.meta.env.DEV` is
// inlined to the literal `false` by `vite build`, so this whole expression folds to a constant
// `false` in production and every branch that depends on it — including the dynamic
// `import('./preview')` in main.tsx — is dead-code eliminated from the shipped bundle.
export function isPreviewMode(): boolean {
  return import.meta.env.DEV && import.meta.env.MODE === 'preview';
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency: string): string {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() });
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(cents / 100);
}

const dateFormatter = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function formatDate(unixSeconds: number | null): string {
  return unixSeconds === null ? '—' : dateFormatter.format(new Date(unixSeconds * 1000));
}
