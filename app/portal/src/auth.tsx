// Clerk-backed API access. AuthApiProvider attaches the caller's session token to every request
// and turns non-OK responses into typed ApiError instances; useApi() reads whichever ApiClient
// the nearest provider put in ApiContext (this one, or preview.ts's fake one — see main.tsx).
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ApiError } from './api';
import type { ApiClient, InvoiceDetail, InvoiceStatus, InvoiceSummary, MeResponse, ServiceSummary } from './api';

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error('useApi must be used within an ApiContext.Provider');
  return client;
}

type Fetcher = (path: string, init?: RequestInit) => Promise<unknown>;

function errorCode(body: unknown): string {
  return typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : 'unknown';
}

function createApiClient(request: Fetcher): ApiClient {
  return {
    me: () => request('/api/me') as Promise<MeResponse>,
    services: async () => {
      const body = (await request('/api/services')) as { services: ServiceSummary[] };
      return body.services;
    },
    invoices: async (status?: InvoiceStatus) => {
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      const body = (await request(`/api/invoices${query}`)) as { invoices: InvoiceSummary[] };
      return body.invoices;
    },
    invoice: id => request(`/api/invoices/${encodeURIComponent(id)}`) as Promise<InvoiceDetail>,
    checkout: id =>
      request(`/api/invoices/${encodeURIComponent(id)}/checkout`, { method: 'POST' }) as Promise<{ url: string }>,
  };
}

export function AuthApiProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();

  const client = useMemo<ApiClient>(
    () =>
      createApiClient(async (path, init) => {
        const token = await getToken();
        const response = await fetch(path, {
          ...init,
          headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token ?? ''}` },
        });
        const text = await response.text();
        const body: unknown = text ? JSON.parse(text) : {};
        if (!response.ok) throw new ApiError(response.status, errorCode(body));
        return body;
      }),
    [getToken],
  );

  return <ApiContext.Provider value={client}>{children}</ApiContext.Provider>;
}
