// Dev-only, in-memory fixture data for `npm run app:portal:preview`. This module is only ever
// reached through the dynamic `import('./preview')` in main.tsx, which is guarded by
// `isPreviewMode()` — a condition that folds to a compile-time `false` in `vite build`, so this
// whole module (and its data) is tree-shaken out of production bundles.
import { ApiError } from './api';
import type { ApiClient, InvoiceDetail, InvoiceItem, InvoicePayment, InvoiceSummary, MeResponse, ServiceSummary } from './api';

const now = Math.floor(Date.now() / 1000);
const day = 86400;

const me: MeResponse = {
  user: { id: 'user-preview' },
  membership: { id: 'membership-preview', role: 'owner', status: 'active' },
  client: { id: 'client-preview', name: 'Acme Corp', billingEmail: 'billing@acme.test' },
  balanceCents: 180000,
};

const invoiceSummaries: InvoiceSummary[] = [
  {
    id: 'inv-open',
    number: 'MON-00003',
    status: 'open',
    totalCents: 180000,
    currency: 'usd',
    description: 'Managed IT — September',
    issuedAt: now - 2 * day,
    dueAt: now + 12 * day,
    paidAt: null,
  },
  {
    id: 'inv-processing',
    number: 'MON-00002',
    status: 'processing',
    totalCents: 420000,
    currency: 'usd',
    description: 'Network hardware refresh',
    issuedAt: now - 6 * day,
    dueAt: now + 8 * day,
    paidAt: null,
  },
  {
    id: 'inv-paid',
    number: 'MON-00001',
    status: 'paid',
    totalCents: 250000,
    currency: 'usd',
    description: 'Onboarding & setup',
    issuedAt: now - 30 * day,
    dueAt: now - 16 * day,
    paidAt: now - 25 * day,
  },
];

const items: Record<string, InvoiceItem[]> = {
  'inv-open': [
    { id: 'item-open-1', description: 'Managed IT — monthly plan', quantity: 1, unitCents: 180000, amountCents: 180000 },
  ],
  'inv-processing': [
    { id: 'item-processing-1', description: 'Network hardware refresh', quantity: 1, unitCents: 420000, amountCents: 420000 },
  ],
  'inv-paid': [
    { id: 'item-paid-1', description: 'Onboarding & setup', quantity: 1, unitCents: 250000, amountCents: 250000 },
  ],
};

const payments: Record<string, InvoicePayment[]> = {
  'inv-open': [],
  'inv-processing': [
    { id: 'pay-processing-1', status: 'processing', amountCents: 420000, method: 'us_bank_account', createdAt: now - day, succeededAt: null },
  ],
  'inv-paid': [
    { id: 'pay-paid-1', status: 'succeeded', amountCents: 250000, method: 'card', createdAt: now - 10 * day, succeededAt: now - 10 * day },
  ],
};

const services: ServiceSummary[] = [
  {
    id: 'svc-managed-it',
    name: 'Managed IT',
    description: 'Monitoring, patching and support for the client fleet.',
    status: 'active',
    startedAt: now - 200 * day,
    endedAt: null,
  },
  {
    id: 'svc-network',
    name: 'Network refresh',
    description: 'Switch and access point replacement across two sites.',
    status: 'ended',
    startedAt: now - 90 * day,
    endedAt: now - 12 * day,
  },
];

// The tree-shake check (`! grep -rl PORTAL_PREVIEW_DATA app/dist/portal/assets`) asserts this
// export never reaches a production build.
export const PORTAL_PREVIEW_DATA = { me, invoiceSummaries, services, items, payments };

function toDetail(summary: InvoiceSummary): InvoiceDetail {
  return { ...summary, items: items[summary.id] ?? [], payments: payments[summary.id] ?? [] };
}

export function createPreviewApiClient(): ApiClient {
  return {
    me: async () => me,
    services: async () => services,
    invoices: async status => (status ? invoiceSummaries.filter(invoice => invoice.status === status) : invoiceSummaries),
    invoice: async id => {
      const summary = invoiceSummaries.find(invoice => invoice.id === id);
      if (!summary) throw new ApiError(404, 'not_found');
      return toDetail(summary);
    },
    // Mirrors the real checkout redirect: send the browser back to the invoice with the same
    // `?checkout=complete` query the portal API's success URL uses.
    checkout: async id => ({ url: `/invoices/${id}?checkout=complete` }),
  };
}
