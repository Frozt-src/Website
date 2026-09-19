import { useCallback, useEffect, useRef, useState } from 'react';
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

// Matches the throttle window portal-api.ts falls back to (checkoutAttemptWindowSeconds) when a
// too_many_attempts body somehow carries no retryAfterSeconds of its own.
const DEFAULT_RETRY_AFTER_SECONDS = 600;

function retryAfterMinutes(body: unknown): number {
  const seconds =
    typeof body === 'object' && body !== null && typeof (body as { retryAfterSeconds?: unknown }).retryAfterSeconds === 'number'
      ? (body as { retryAfterSeconds: number }).retryAfterSeconds
      : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(1, Math.round(seconds / 60));
}

// Branches on the error code the API attached, not just its HTTP status, since one status (409,
// 503) covers more than one code with different copy.
function payErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'We could not start checkout. Please try again.';
  switch (err.code) {
    case 'payment_in_progress':
      return 'A payment for this invoice is already in progress. Please check back shortly.';
    case 'invoice_not_payable':
      return 'This invoice can no longer be paid.';
    case 'too_many_attempts':
      return `Too many payment attempts. Please wait about ${retryAfterMinutes(err.body)} minutes and try again.`;
    case 'payments_not_configured':
    case 'payments_unavailable':
      return 'Payments are not available right now.';
    default:
      return 'We could not start checkout. Please try again.';
  }
}

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

  // Whether we're waiting on the webhook to flip this invoice off 'open'. A plain boolean (not the
  // invoice object) so the polling effect below doesn't see a new dependency value on every poll.
  const confirming = checkoutParam === 'complete' && invoice?.status === 'open';

  // The poll loop reads the latest status through a ref instead of `invoice` directly, so a
  // successful poll (which calls setInvoice) doesn't change the effect's own dependencies.
  const statusRef = useRef(invoice?.status);
  useEffect(() => {
    statusRef.current = invoice?.status;
  }, [invoice?.status]);

  // The webhook that flips the invoice to processing/paid can land seconds after Stripe redirects
  // the payer back, so while it's still open here, poll for up to 60s. The deadline lives in a ref
  // set once when polling starts: depending on `confirming`/`id` rather than `invoice` keeps each
  // successful poll from recreating the interval and pushing the 60s deadline back out. Stops on
  // its own once the status changes, the deadline passes, or the component unmounts.
  const deadlineRef = useRef(0);
  useEffect(() => {
    if (!confirming) return;
    deadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled) return;
      if (Date.now() >= deadlineRef.current || statusRef.current !== 'open') {
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
  }, [confirming, id, api]);

  const pay = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const { url } = await api.checkout(id);
      window.location.href = url;
    } catch (err) {
      setPaying(false);
      setPayError(payErrorMessage(err));
    }
  };

  const backLink = (
    <Link href="/invoices" className="portal-button portal-button-secondary">
      Back to invoices
    </Link>
  );

  if (error) {
    return (
      <section className="portal-section" aria-labelledby="invoice-title">
        {backLink}
        <h1 id="invoice-title">Invoice</h1>
        <p className="portal-error" role="alert">
          {error}
        </p>
      </section>
    );
  }
  if (!invoice) {
    return (
      <section className="portal-section" aria-labelledby="invoice-title">
        {backLink}
        <h1 id="invoice-title">Invoice</h1>
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
