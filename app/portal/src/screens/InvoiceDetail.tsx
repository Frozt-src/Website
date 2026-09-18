import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../auth';
import { ApiError, formatDate, formatMoney, navigate } from '../api';
import type { InvoiceDetail as InvoiceDetailData, InvoiceStatus } from '../api';

const statusLabel: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  processing: 'Processing',
  paid: 'Paid',
  void: 'Void',
};

export default function InvoiceDetail({ id }: { id: string }) {
  const api = useApi();
  const [invoice, setInvoice] = useState<InvoiceDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const checkoutComplete = new URLSearchParams(window.location.search).get('checkout') === 'complete';

  const load = useCallback(() => {
    setError(null);
    api
      .invoice(id)
      .then(setInvoice)
      .catch((err: unknown) => {
        setError(err instanceof ApiError && err.status === 404 ? 'Invoice not found.' : 'We could not load this invoice.');
      });
  }, [api, id]);

  // Re-fetches on every navigation to this invoice, including the checkout success redirect
  // (`?checkout=complete`), so a confirmed payment's status shows up without a manual reload.
  useEffect(() => {
    load();
  }, [load]);

  const pay = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await api.checkout(id);
      window.location.href = url;
    } catch (err) {
      setPaying(false);
      if (err instanceof ApiError && err.status === 409) setPayError('This invoice can no longer be paid.');
      else if (err instanceof ApiError && err.status === 503) setPayError('Payments are not available right now.');
      else setPayError('We could not start checkout. Please try again.');
    }
  };

  const backButton = (
    <button type="button" className="portal-button portal-button-secondary" onClick={() => navigate('/invoices')}>
      Back to invoices
    </button>
  );

  if (error) {
    return (
      <section className="portal-section">
        {backButton}
        <p className="portal-error">{error}</p>
      </section>
    );
  }
  if (!invoice) {
    return (
      <section className="portal-section">
        {backButton}
        <p className="portal-meta">Loading…</p>
      </section>
    );
  }

  return (
    <section className="portal-section" aria-labelledby="invoice-title">
      {backButton}
      <h1 id="invoice-title">{invoice.number}</h1>
      <p className="portal-meta">{invoice.description}</p>
      <p>
        <span className={`portal-status portal-status-${invoice.status}`}>{statusLabel[invoice.status]}</span>
      </p>
      {checkoutComplete && <p className="portal-notice-banner">Thanks, we're confirming your payment.</p>}

      <table className="portal-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Qty</th>
            <th scope="col">Unit</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map(item => (
            <tr key={item.id}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatMoney(item.unitCents, invoice.currency)}</td>
              <td>{formatMoney(item.amountCents, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="portal-total">Total: {formatMoney(invoice.totalCents, invoice.currency)}</p>

      {invoice.status === 'open' && (
        <button type="button" className="portal-button" onClick={pay} disabled={paying}>
          {paying ? 'Starting checkout…' : 'Pay invoice'}
        </button>
      )}
      {payError && <p className="portal-error">{payError}</p>}

      {invoice.payments.length > 0 && (
        <>
          <h2>Payments</h2>
          <table className="portal-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Method</th>
                <th scope="col">Amount</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map(payment => (
                <tr key={payment.id}>
                  <td>{payment.status}</td>
                  <td>{payment.method ?? '—'}</td>
                  <td>{formatMoney(payment.amountCents, invoice.currency)}</td>
                  <td>{formatDate(payment.succeededAt ?? payment.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
