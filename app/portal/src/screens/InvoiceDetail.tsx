import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../auth';
import { ApiError, formatDate, formatMoney } from '../api';
import type { InvoiceDetail as InvoiceDetailData, InvoiceStatus, PaymentStatus } from '../api';
import Link from '../Link';

const statusLabel: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  processing: 'Processing',
  paid: 'Paid',
  void: 'Void',
};

const paymentStatusLabel: Record<PaymentStatus, string> = {
  pending: 'Started',
  processing: 'Processing',
  succeeded: 'Paid',
  failed: 'Failed',
  canceled: 'Cancelled',
};

const methodLabel: Record<string, string> = {
  card: 'Card',
  us_bank_account: 'Bank account (ACH)',
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

// Mirrors completePage's three-way wording (app/src/pay/render.ts) so the pay host and the portal
// describe the same moment the same way.
function checkoutMessage(checkoutParam: string | null, status: InvoiceStatus): string | null {
  if (checkoutParam === 'cancelled') return 'Payment cancelled. You can pay whenever you’re ready.';
  if (checkoutParam !== 'complete') return null;
  if (status === 'paid') return 'Thank you — your payment has been received.';
  if (status === 'processing') return 'Your bank payment is processing. This can take a few business days.';
  return 'We’re confirming your payment…';
}

export default function InvoiceDetail({ id }: { id: string }) {
  const api = useApi();
  const [invoice, setInvoice] = useState<InvoiceDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  // Captured once on mount, then stripped from the URL so a reload or bookmark doesn't re-show
  // the checkout banner indefinitely.
  const [checkoutParam] = useState(() => new URLSearchParams(window.location.search).get('checkout'));
  useEffect(() => {
    if (!checkoutParam) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('checkout');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, [checkoutParam]);

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

  // The webhook that flips the invoice to processing/paid can land seconds after Stripe redirects
  // the payer back, so while it's still open here, poll for up to 60s. Stops on its own once the
  // status changes (the dependency below no longer reads 'open') or the component unmounts.
  useEffect(() => {
    if (checkoutParam !== 'complete' || !invoice || invoice.status !== 'open') return;
    let cancelled = false;
    const start = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - start >= POLL_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }
      api
        .invoice(id)
        .then(result => {
          if (!cancelled) setInvoice(result);
        })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [checkoutParam, invoice, api, id]);

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

  const backLink = (
    <Link href="/invoices" className="portal-button portal-button-secondary">
      Back to invoices
    </Link>
  );

  if (error) {
    return (
      <section className="portal-section">
        {backLink}
        <p className="portal-error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!invoice) {
    return (
      <section className="portal-section">
        {backLink}
        <p className="portal-meta" role="status">
          Loading…
        </p>
      </section>
    );
  }

  const banner = checkoutMessage(checkoutParam, invoice.status);
  const showPayButton = invoice.status === 'open' && checkoutParam !== 'complete';

  return (
    <section className="portal-section" aria-labelledby="invoice-title">
      {backLink}
      <h1 id="invoice-title">{invoice.number}</h1>
      <p className="portal-meta">{invoice.description}</p>
      <p>
        <span className={`portal-status portal-status-${invoice.status}`}>{statusLabel[invoice.status]}</span>
      </p>
      {banner && (
        <p className="portal-notice-banner" role="status">
          {banner}
        </p>
      )}

      <div className="portal-table-wrap">
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
                <td className="portal-money">{formatMoney(item.unitCents, invoice.currency)}</td>
                <td className="portal-money">{formatMoney(item.amountCents, invoice.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="portal-total">Total: {formatMoney(invoice.totalCents, invoice.currency)}</p>

      {showPayButton && (
        <button type="button" className="portal-button" onClick={pay} disabled={paying}>
          {paying ? 'Starting checkout…' : 'Pay invoice'}
        </button>
      )}
      {payError && (
        <p className="portal-error" role="alert">
          {payError}
        </p>
      )}

      {invoice.payments.length > 0 && (
        <>
          <h2>Payments</h2>
          <div className="portal-table-wrap">
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
                    <td>{paymentStatusLabel[payment.status]}</td>
                    <td>{payment.method ? (methodLabel[payment.method] ?? payment.method) : '—'}</td>
                    <td className="portal-money">{formatMoney(payment.amountCents, invoice.currency)}</td>
                    <td>{formatDate(payment.succeededAt ?? payment.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
