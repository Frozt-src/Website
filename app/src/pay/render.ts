// Pure HTML rendering for the pay host. Every interpolated value passes through escapeHtml; no
// inline styles or scripts, matching the pay CSP (`default-src 'none'; style-src 'self'`).
import { formatUsd } from '../domain/money.ts';
import type { Invoice, InvoiceItem } from '../domain/models.ts';

// The site's three-bar mark (public/favicon.svg), served at GET /favicon.svg.
export const faviconSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="7" fill="#101314"/><path fill="#edf1f2" d="m8 14 6-3v22H8V14Zm9-5 6-3v27h-6V9Zm9 7 6-3v20h-6V16Z"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Built from three single-purpose formatters (rather than one Intl.DateTimeFormat with day/month/
// year options) because locale option order does not control output order: en-US's own default
// order is "Sep 18, 2026", not the "18 Sep 2026" this host renders everywhere.
const dayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: 'numeric' });
const monthFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short' });
const yearFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' });

function formatDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${dayFormatter.format(date)} ${monthFormatter.format(date)} ${yearFormatter.format(date)}`;
}

function wordmark(): string {
  return '<header class="wordmark">MONOLITH</header>';
}

function footer(year: number): string {
  return `<footer class="footer">© ${year} Monolith · eldritch@mnlith.dev</footer>`;
}

export function layout(input: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#101314">
<title>${escapeHtml(input.title)}</title>
<link rel="stylesheet" href="/pay.css">
<link rel="icon" href="/favicon.svg">
</head>
<body>
${input.body}
</body>
</html>`;
}

export interface InvoicePageInput {
  token: string;
  invoice: Invoice;
  items: InvoiceItem[];
  year: number;
}

export function invoicePage(input: InvoicePageInput): string {
  const { token, invoice, items, year } = input;
  const rows = items
    .map(
      item =>
        `<tr><td>${escapeHtml(item.description)}</td><td>${item.quantity}</td><td>${formatUsd(item.amountCents)}</td></tr>`,
    )
    .join('');
  const body = `${wordmark()}
<main>
<h1>Invoice ${escapeHtml(invoice.number)}</h1>
<p class="description">${escapeHtml(invoice.description)}</p>
<table>
<caption class="visually-hidden">Invoice line items</caption>
<thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Amount</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p class="amount-due"><span>Amount due</span><strong>${formatUsd(invoice.totalCents)}</strong></p>
<form method="post" action="/i/${escapeHtml(token)}/checkout">
<button type="submit">Pay invoice</button>
</form>
<p class="note">Payments are processed securely by Stripe.</p>
</main>
${footer(year)}`;
  return layout({ title: `Invoice ${invoice.number}`, body });
}

export interface PaidPageInput {
  invoice: Invoice;
  year: number;
}

export function paidPage(input: PaidPageInput): string {
  const { invoice, year } = input;
  const paidDate = invoice.paidAt !== null ? formatDate(invoice.paidAt) : '';
  const body = `${wordmark()}
<main>
<h1>Invoice ${escapeHtml(invoice.number)}</h1>
<p class="status">Paid</p>
<p>Paid on ${escapeHtml(paidDate)}.</p>
<p class="amount-due"><span>Amount</span><strong>${formatUsd(invoice.totalCents)}</strong></p>
</main>
${footer(year)}`;
  return layout({ title: `Invoice ${invoice.number}`, body });
}

export interface ProcessingPageInput {
  invoice: Invoice;
  year: number;
}

export function processingPage(input: ProcessingPageInput): string {
  const { invoice, year } = input;
  const body = `${wordmark()}
<main>
<h1>Invoice ${escapeHtml(invoice.number)}</h1>
<p class="status">Payment processing</p>
<p>We’re processing your bank payment (ACH). This can take a few business days; no action is needed.</p>
</main>
${footer(year)}`;
  return layout({ title: `Invoice ${invoice.number}`, body });
}

export interface CompletePageInput {
  invoice: Invoice;
  year: number;
}

// Reached from Stripe with only the Checkout Session id, so nothing here can reference the payment
// link: no token in the copy, and no link back to the tokenised invoice page.
export function completePage(input: CompletePageInput): string {
  const { invoice, year } = input;
  let title: string;
  let message: string;
  let details = '';
  if (invoice.status === 'paid') {
    const paidDate = invoice.paidAt !== null ? formatDate(invoice.paidAt) : '';
    title = 'Payment received';
    message = 'Thank you — your payment has been received.';
    details = `<p>Invoice ${escapeHtml(invoice.number)}, paid on ${escapeHtml(paidDate)}.</p>
<p class="amount-due"><span>Amount</span><strong>${formatUsd(invoice.totalCents)}</strong></p>`;
  } else if (invoice.status === 'processing') {
    title = 'Payment processing';
    message = 'Your bank payment is processing. This can take a few business days.';
  } else {
    title = 'Confirming your payment';
    message = 'We’re confirming your payment. This can take a minute; you can safely close this page.';
  }
  const body = `${wordmark()}
<main>
<h1>${title}</h1>
<p>${message}</p>
${details}</main>
${footer(year)}`;
  return layout({ title, body });
}

export interface PaymentInProgressPageInput {
  invoice: Invoice;
  year: number;
}

// Shown when the other channel's checkout session is still live at Stripe and cannot be expired
// (e.g. it already completed there): the same shape as processingPage, since this too is a
// wait-and-retry state for the payer, not an error.
export function paymentInProgressPage(input: PaymentInProgressPageInput): string {
  const { invoice, year } = input;
  const body = `${wordmark()}
<main>
<h1>Invoice ${escapeHtml(invoice.number)}</h1>
<p class="status">Payment in progress</p>
<p>A payment for this invoice is already in progress. Please check back shortly.</p>
</main>
${footer(year)}`;
  return layout({ title: `Invoice ${invoice.number}`, body });
}

export interface CancelPageInput {
  year: number;
}

export function cancelPage(input: CancelPageInput): string {
  const body = `${wordmark()}
<main>
<h1>Checkout cancelled</h1>
<p>Your payment was cancelled. Use the link from your invoice email to try again.</p>
</main>
${footer(input.year)}`;
  return layout({ title: 'Checkout cancelled', body });
}

// 'invoice-link' (the default) covers the /i/* and /checkout/* routes, where the visitor almost
// always arrived via a stale or tampered payment link. Every other unmatched path on this host
// (e.g. /robots.txt) gets the generic variant instead, which doesn't imply a link was involved.
export type NotFoundKind = 'invoice-link' | 'generic';

export function notFoundPage(kind: NotFoundKind = 'invoice-link'): string {
  const message = kind === 'generic' ? 'That page doesn’t exist.' : 'This payment link is no longer valid.';
  const body = `${wordmark()}
<main>
<h1>Page not found</h1>
<p>${message}</p>
<p>Questions? Email <a href="mailto:eldritch@mnlith.dev">eldritch@mnlith.dev</a>.</p>
</main>`;
  return layout({ title: 'Page not found', body });
}

export function tooManyAttemptsPage(): string {
  const body = `${wordmark()}
<main>
<h1>Too many payment attempts</h1>
<p>Too many payment attempts. Please wait a few minutes and try again.</p>
<p>Questions? Email <a href="mailto:eldritch@mnlith.dev">eldritch@mnlith.dev</a>.</p>
</main>`;
  return layout({ title: 'Too many payment attempts', body });
}

export function unavailablePage(): string {
  const body = `${wordmark()}
<main>
<h1>Payments are not available right now</h1>
<p>Please try again in a few minutes.</p>
<p>Questions? Email <a href="mailto:eldritch@mnlith.dev">eldritch@mnlith.dev</a>.</p>
</main>`;
  return layout({ title: 'Payments unavailable', body });
}
