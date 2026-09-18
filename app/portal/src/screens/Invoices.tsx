import { useEffect, useState } from 'react';
import { useApi } from '../auth';
import { formatDate, formatMoney } from '../api';
import type { InvoiceStatus, InvoiceSummary } from '../api';
import Link from '../Link';

const statusLabel: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  processing: 'Processing',
  paid: 'Paid',
  void: 'Void',
};

export default function Invoices() {
  const api = useApi();
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .invoices()
      .then(result => {
        if (!cancelled) setInvoices(result);
      })
      .catch(() => {
        if (!cancelled) setError('We could not load your invoices.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <section className="portal-section" aria-labelledby="invoices-title">
      <h1 id="invoices-title">Invoices</h1>
      {error && (
        <p className="portal-error" role="alert">
          {error}
        </p>
      )}
      {!error && !invoices && (
        <p className="portal-meta" role="status">
          Loading…
        </p>
      )}
      {invoices && invoices.length === 0 && (
        <p className="portal-meta" role="status">
          No invoices yet.
        </p>
      )}
      {invoices && invoices.length > 0 && (
        <div className="portal-table-wrap">
          <table className="portal-table">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Status</th>
                <th scope="col">Amount</th>
                <th scope="col">Due</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(invoice => (
                <tr key={invoice.id}>
                  <td className="portal-nowrap">
                    <Link href={`/invoices/${invoice.id}`}>{invoice.number}</Link>
                  </td>
                  <td>
                    <span className={`portal-status portal-status-${invoice.status}`}>{statusLabel[invoice.status]}</span>
                  </td>
                  <td className="portal-money">{formatMoney(invoice.totalCents, invoice.currency)}</td>
                  <td>{formatDate(invoice.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
