// Checkout creation and the Stripe webhook state machine. Every state change is a conditional
// update inside one batch with the event insert, so replays and out-of-order deliveries are safe.
import { newId } from './ids.ts';
import { auditStatement } from './audit.ts';
import { toInvoice } from './invoices.ts';
import type { InvoiceRow } from './invoices.ts';
import type { Client, Invoice, Payment, PaymentStatus } from './models.ts';
import type { StripeEvent, StripeGateway } from '../deps.ts';

const sessionLifetimeSeconds = 1800;
// Stripe refuses an expiry less than 30 minutes ahead of *its* clock when it processes the create
// call, and our timestamp is already a round trip old by then. Ask Stripe for slightly longer than
// we store, so our reuse window is the one that closes first.
const gatewayExpiryCushionSeconds = 30;
// How long a request that lost the claim waits for the winner's checkout url before giving up.
const claimPollDelayMs = 150;
const claimPollAttempts = 10;

const handledTypes = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
]);

interface PaymentRow {
  id: string;
  invoice_id: string;
  client_id: string;
  payment_link_id: string | null;
  source: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
  checkout_url: string | null;
  amount_cents: number;
  currency: string;
  method: string | null;
  status: string;
  session_expires_at: number;
  created_at: number;
  updated_at: number;
  succeeded_at: number | null;
  failed_at: number | null;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    clientId: row.client_id,
    paymentLinkId: row.payment_link_id,
    source: row.source as Payment['source'],
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    checkoutUrl: row.checkout_url,
    amountCents: row.amount_cents,
    currency: row.currency,
    method: row.method,
    status: row.status as PaymentStatus,
    sessionExpiresAt: row.session_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    succeededAt: row.succeeded_at,
    failedAt: row.failed_at,
  };
}

function invoiceNotPayable(): Error {
  // The HTTP layers map the code to 409 (portal) or a redirect back to the invoice (pay host).
  return Object.assign(new Error('invoice is not payable'), { code: 'invoice_not_payable' });
}

function paymentInProgress(): Error {
  // The HTTP layers map the code to 409 (portal) or the in-progress page (pay host).
  return Object.assign(new Error('a payment for this invoice is already in progress'), { code: 'payment_in_progress' });
}

export interface StartCheckoutInput {
  invoice: Invoice;
  client: Client;
  source: 'payment_link' | 'portal';
  paymentLinkId?: string;
  successUrl: string;
  cancelUrl: string;
}

interface CheckoutDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  stripe: StripeGateway;
  logError(event: string, error: unknown): void;
}

// The payment still holding the invoice, if any. The `payments_one_open` index makes this at most
// one row, which is what lets a checkout claim the invoice by inserting rather than by locking.
function openPayment(db: D1Database, invoiceId: string): Promise<PaymentRow | null> {
  return db
    .prepare(`SELECT * FROM payments WHERE invoice_id = ? AND status IN ('pending', 'processing') ORDER BY created_at DESC`)
    .bind(invoiceId)
    .first<PaymentRow>();
}

// Both D1 and SQLite name the broken constraint in the error message. The claim batch can only
// break `payments_one_open`: its placeholder session id is derived from a fresh payment id.
function claimLost(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

// The claim is taken before Stripe is called, so the winner's row exists with no url for as long as
// the Stripe round trip lasts. A request that lost the claim waits for that url rather than opening
// a second live session for the same invoice.
async function urlFromClaimWinner(
  db: D1Database,
  deps: CheckoutDeps,
  input: StartCheckoutInput,
): Promise<{ url: string; payment: Payment }> {
  for (let attempt = 0; attempt < claimPollAttempts; attempt++) {
    await deps.sleep(claimPollDelayMs);
    const winner = await openPayment(db, input.invoice.id);
    if (!winner?.checkout_url) continue;
    // The winner's session returns the payer to its own channel's urls, so it is only shareable
    // with a request from that same channel.
    if (winner.source !== input.source) throw paymentInProgress();
    return { url: winner.checkout_url, payment: toPayment(winner) };
  }
  throw paymentInProgress();
}

export async function startCheckout(
  db: D1Database,
  deps: CheckoutDeps,
  input: StartCheckoutInput,
): Promise<{ url: string; payment: Payment }> {
  if (input.invoice.status !== 'open') throw invoiceNotPayable();
  const at = deps.now();

  const open = await openPayment(db, input.invoice.id);
  const expired = open !== null && open.session_expires_at <= at;
  // A live session is only reusable by the channel that created it: the two channels send the payer
  // to different return urls, and the payment row records the channel the money came through.
  const liveUrl = open && !expired ? open.checkout_url : null;
  if (open && liveUrl) {
    if (open.source === input.source) return { url: liveUrl, payment: toPayment(open) };
    // The other channel's session is still payable at Stripe, so close it before opening ours. If
    // Stripe refuses (e.g. the session already completed and can no longer be expired), a payment is
    // genuinely in flight: report that instead of opening a second live session for the same invoice.
    try {
      await deps.stripe.expireCheckoutSession(open.stripe_checkout_session_id);
    } catch (error) {
      deps.logError('checkout_expire_failed', error);
      throw paymentInProgress();
    }
  }

  const paymentId = newId();
  const expiresAt = at + sessionLifetimeSeconds;
  const claim: PaymentRow = {
    id: paymentId,
    invoice_id: input.invoice.id,
    client_id: input.invoice.clientId,
    payment_link_id: input.paymentLinkId ?? null,
    source: input.source,
    // A placeholder until Stripe answers: the column is NOT NULL UNIQUE, and applyStripeEvent below
    // refuses to look up any event whose session id starts with `claim:`, so the webhook state
    // machine never matches an unfinished claim even if an event happened to carry this literal id.
    stripe_checkout_session_id: `claim:${paymentId}`,
    stripe_payment_intent_id: null,
    checkout_url: null,
    amount_cents: input.invoice.totalCents,
    currency: input.invoice.currency,
    method: null,
    status: 'pending',
    session_expires_at: expiresAt,
    created_at: at,
    updated_at: at,
    succeeded_at: null,
    failed_at: null,
  };

  const statements: D1PreparedStatement[] = [];
  // The stale session is cancelled in the same batch that claims the invoice for its replacement.
  // Statements in a batch run in order inside one transaction, so the cancellation has already
  // freed the index by the time the insert below is checked against it. An unexpired row with no
  // url yet is a claim another request is still at Stripe with, and is never cancelled: leaving it
  // in place is what makes the insert below fail and this request wait for that request's url.
  if (open && (expired || liveUrl)) {
    statements.push(
      db
        .prepare(`UPDATE payments SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(at, open.id),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO payments (id, invoice_id, client_id, payment_link_id, source, stripe_checkout_session_id,
        checkout_url, amount_cents, currency, status, session_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .bind(
        claim.id,
        claim.invoice_id,
        claim.client_id,
        claim.payment_link_id,
        claim.source,
        claim.stripe_checkout_session_id,
        claim.checkout_url,
        claim.amount_cents,
        claim.currency,
        claim.session_expires_at,
        claim.created_at,
        claim.updated_at,
      ),
    auditStatement(db, {
      occurredAt: at,
      actorType: 'system',
      actorId: null,
      clientId: claim.client_id,
      entityType: 'payment',
      entityId: claim.id,
      action: 'checkout.created',
      detailsJson: JSON.stringify({ invoiceId: claim.invoice_id, source: claim.source, amountCents: claim.amount_cents }),
    }),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    if (!claimLost(error)) throw error;
    return urlFromClaimWinner(db, deps, input);
  }

  let session: { id: string; url: string };
  try {
    session = await deps.stripe.createCheckoutSession({
      idempotencyKey: paymentId,
      invoiceId: input.invoice.id,
      invoiceNumber: input.invoice.number,
      paymentId,
      description: input.invoice.description,
      amountCents: input.invoice.totalCents,
      currency: input.invoice.currency,
      customerEmail: input.client.billingEmail,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      expiresAt: expiresAt + gatewayExpiryCushionSeconds,
    });
  } catch (error) {
    // No session exists, so the claim must be released or the invoice stays unpayable until the
    // row expires. Cancelling it frees the index for the next attempt.
    await db
      .prepare(`UPDATE payments SET status = 'canceled', failed_at = ?, updated_at = ? WHERE id = ?`)
      .bind(at, at, paymentId)
      .run();
    throw error;
  }

  const row: PaymentRow = { ...claim, stripe_checkout_session_id: session.id, checkout_url: session.url };
  const update = await db
    .prepare(`UPDATE payments SET stripe_checkout_session_id = ?, checkout_url = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(row.stripe_checkout_session_id, row.checkout_url, at, row.id)
    .run();
  if (update.meta.changes !== 1) {
    // The claim row changed under us (e.g. an expiry sweep cancelled it) between Stripe answering
    // and this update, so the session Stripe just created has no payment row pointing back to it.
    // Best effort: close it so it cannot be paid into an invoice that no longer claims it.
    try {
      await deps.stripe.expireCheckoutSession(session.id);
    } catch (error) {
      deps.logError('checkout_claim_lost_after_create', error);
    }
    deps.logError('checkout_claim_lost_after_create', new Error(`claim ${row.id} was lost after its Stripe session was created`));
    throw paymentInProgress();
  }

  return { url: session.url, payment: toPayment(row) };
}

// The pay host's post-Checkout pages know only the Stripe session id, so the invoice is resolved
// from the payment row. Scoped to payment-link checkouts: a portal session belongs to the portal.
export async function invoiceForPaymentLinkSession(db: D1Database, sessionId: string): Promise<Invoice | null> {
  const row = await db
    .prepare(`SELECT i.* FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.stripe_checkout_session_id = ? AND p.source = 'payment_link'`)
    .bind(sessionId)
    .first<InvoiceRow>();
  // A void or draft invoice is not the payer's to see through this lookup: void means the bill was
  // withdrawn, and draft was never issued. Both render the generic 404, same as an unknown session.
  if (!row || row.status === 'void' || row.status === 'draft') return null;
  return toInvoice(row);
}

export async function listPaymentsForInvoice(db: D1Database, invoiceId: string): Promise<Payment[]> {
  const { results } = await db
    .prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY created_at')
    .bind(invoiceId)
    .all<PaymentRow>();
  return results.map(toPayment);
}

export type StripeEventOutcome = 'applied' | 'ignored' | 'unmatched' | 'mismatch' | 'duplicate';

// `duplicate` is never stored: the UNIQUE(stripe_event_id) violation rolls the whole batch back.
type StoredOutcome = Exclude<StripeEventOutcome, 'duplicate'>;

async function commit(
  db: D1Database,
  event: StripeEvent,
  statements: D1PreparedStatement[],
  outcome: StoredOutcome,
): Promise<{ outcome: StripeEventOutcome }> {
  try {
    await db.batch(statements);
    return { outcome };
  } catch (error) {
    // The event insert is part of the batch, so a row that exists now means this is a replay and
    // nothing was applied. Anything else is a real failure and must reach the caller as a 500.
    const seen = await db
      .prepare('SELECT id FROM payment_events WHERE stripe_event_id = ?')
      .bind(event.id)
      .first<{ id: string }>();
    if (seen) return { outcome: 'duplicate' };
    throw error;
  }
}

// `invoice.paid` must mean the invoice really was marked paid by this batch, not that an event
// asked for it: the update ahead of it is conditional on the payment having succeeded, and a
// payment that had already failed leaves it a no-op. The EXISTS clause reads the invoice row this
// batch just wrote (statements run in order inside one transaction), so the audit follows the fact.
function invoicePaidAudit(
  db: D1Database,
  at: number,
  event: StripeEvent,
  row: PaymentRow & { invoice_status: string },
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO audit_events (id, occurred_at, actor_type, actor_id, client_id, entity_type, entity_id, action, details_json)
      SELECT ?, ?, 'stripe', ?, ?, 'invoice', ?, 'invoice.paid', ?
      WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'paid' AND paid_at = ?)`)
    .bind(
      newId(),
      at,
      event.id,
      row.client_id,
      row.invoice_id,
      JSON.stringify({ paymentId: row.id, amountCents: row.amount_cents }),
      row.invoice_id,
      at,
    );
}

// The audit for a paying event follows what the conditional invoice update can actually do: only an
// open or processing invoice becomes paid. Money landing on any other invoice state is an alarm, and
// the two alarms are kept apart so the audit trail names the real situation.
function paidAudit(
  db: D1Database,
  at: number,
  event: StripeEvent,
  row: PaymentRow & { invoice_status: string },
): D1PreparedStatement | null {
  const actor = { occurredAt: at, actorType: 'stripe' as const, actorId: event.id, clientId: row.client_id };
  if (row.invoice_status === 'open' || row.invoice_status === 'processing') {
    return invoicePaidAudit(db, at, event, row);
  }
  if (row.invoice_status === 'paid') {
    // Another payment settling an already settled bill is money in twice. The payment that settled
    // it is already succeeded, so a further event about it is just Stripe repeating itself.
    if (row.status === 'succeeded') return null;
    return auditStatement(db, {
      ...actor,
      entityType: 'payment',
      entityId: row.id,
      action: 'payment.duplicate_suspected',
      detailsJson: JSON.stringify({ invoiceId: row.invoice_id, amountCents: row.amount_cents }),
    });
  }
  // void or draft: the payment succeeds but the bill cannot take it, so somebody has to look.
  return auditStatement(db, {
    ...actor,
    entityType: 'payment',
    entityId: row.id,
    action: 'payment.unexpected_invoice_state',
    detailsJson: JSON.stringify({
      invoiceId: row.invoice_id,
      invoiceStatus: row.invoice_status,
      amountCents: row.amount_cents,
    }),
  });
}

// Stripe echoes the return urls back on every checkout.session.* event. They are ours, they are of
// no forensic value, and historically they carried a payment-link token, so the stored copy of the
// event never has them. The clone is shallow and the in-memory event is never mutated.
function redactedPayload(event: StripeEvent): string {
  const object = event.data.object;
  if (!object || typeof object !== 'object') return JSON.stringify(event);
  const { success_url: _successUrl, cancel_url: _cancelUrl, url: _url, ...rest } = object;
  return JSON.stringify({ ...event, data: { ...event.data, object: rest } });
}

// A refund, dispute or payment-intent event names its payment intent rather than a session:
// `data.object.payment_intent` on a charge or dispute, `data.object.id` on a payment_intent.*.
async function paymentForIntent(
  db: D1Database,
  event: StripeEvent,
): Promise<{ id: string; invoice_id: string } | null> {
  const object = event.data.object;
  if (!object || typeof object !== 'object') return null;
  const intentId =
    typeof object.payment_intent === 'string'
      ? object.payment_intent
      : event.type.startsWith('payment_intent.') && typeof object.id === 'string'
        ? object.id
        : null;
  if (!intentId) return null;
  return db
    .prepare('SELECT id, invoice_id FROM payments WHERE stripe_payment_intent_id = ?')
    .bind(intentId)
    .first<{ id: string; invoice_id: string }>();
}

export async function applyStripeEvent(
  db: D1Database,
  deps: { now(): number; stripeMode: 'test' | 'live' },
  event: StripeEvent,
): Promise<{ outcome: StripeEventOutcome }> {
  const at = deps.now();
  const payloadJson = redactedPayload(event);
  const eventStatement = (outcome: StoredOutcome, paymentId: string | null, invoiceId: string | null) =>
    db
      .prepare(`INSERT INTO payment_events (id, stripe_event_id, type, livemode, payment_id, invoice_id, outcome, payload_json, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId(), event.id, event.type, event.livemode ? 1 : 0, paymentId, invoiceId, outcome, payloadJson, at);

  if (event.livemode !== (deps.stripeMode === 'live')) {
    return commit(db, event, [eventStatement('ignored', null, null)], 'ignored');
  }

  const session = event.data.object;
  if (!handledTypes.has(event.type)) {
    // Refunds and disputes change no state in Phase 1, but the history is only useful if it can be
    // joined to the payment it belongs to, so the row is linked through the payment intent.
    const linked = await paymentForIntent(db, event);
    return commit(db, event, [eventStatement('ignored', linked?.id ?? null, linked?.invoice_id ?? null)], 'ignored');
  }

  const sessionId = typeof session.id === 'string' ? session.id : '';
  // No real Stripe session id can ever look like this (see the claim placeholder above), so an event
  // that carries one anyway is treated as unmatched before it is ever looked up against a payment row.
  if (sessionId.startsWith('claim:')) {
    return commit(db, event, [eventStatement('unmatched', null, null)], 'unmatched');
  }
  const row = await db
    .prepare(`SELECT p.*, i.status AS invoice_status FROM payments p
      JOIN invoices i ON i.id = p.invoice_id WHERE p.stripe_checkout_session_id = ?`)
    .bind(sessionId)
    .first<PaymentRow & { invoice_status: string }>();
  if (!row) return commit(db, event, [eventStatement('unmatched', null, null)], 'unmatched');

  // The amount is verified against the payment row, never taken from the event. A session that does
  // not state its amount and currency cannot be verified, so it counts as a mismatch.
  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
  const currency = typeof session.currency === 'string' ? session.currency.toLowerCase() : null;
  if (amountTotal !== row.amount_cents || currency !== row.currency) {
    return commit(
      db,
      event,
      [
        eventStatement('mismatch', row.id, row.invoice_id),
        auditStatement(db, {
          occurredAt: at,
          actorType: 'stripe',
          actorId: event.id,
          clientId: row.client_id,
          entityType: 'payment',
          entityId: row.id,
          action: 'payment.amount_mismatch',
          detailsJson: JSON.stringify({
            expectedAmountCents: row.amount_cents,
            expectedCurrency: row.currency,
            sessionAmountCents: amountTotal,
            sessionCurrency: currency,
          }),
        }),
      ],
      'mismatch',
    );
  }

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  // Under automatic payment methods a session lists every method enabled on the account, so the
  // list only identifies what was used when it holds exactly one entry. Best-effort in Phase 1.
  const methodTypes = Array.isArray(session.payment_method_types) ? session.payment_method_types : [];
  const method = methodTypes.length === 1 && typeof methodTypes[0] === 'string' ? methodTypes[0] : null;
  const paidNow =
    event.type === 'checkout.session.async_payment_succeeded' ||
    (event.type === 'checkout.session.completed' && session.payment_status === 'paid');

  const statements: D1PreparedStatement[] = [eventStatement('applied', row.id, row.invoice_id)];
  if (paidNow) {
    // A payment this Worker cancelled locally can still be charged: Stripe holds the session open a
    // little longer than our reuse window, so `canceled` is a legal source state for money arriving.
    // An async failure is final for that payment, so only the async success path reopens it.
    const payable =
      event.type === 'checkout.session.async_payment_succeeded'
        ? `('pending', 'processing', 'canceled', 'failed')`
        : `('pending', 'processing', 'canceled')`;
    statements.push(
      db
        .prepare(`UPDATE payments SET status = 'succeeded', stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
          method = COALESCE(?, method), succeeded_at = ?, updated_at = ? WHERE id = ? AND status IN ${payable}`)
        .bind(paymentIntentId, method, at, at, row.id),
      // Conditional on the payment update above having landed, so a payment left in another state
      // (e.g. already failed) can never mark the bill paid.
      db
        .prepare(`UPDATE invoices SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'processing')
          AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'succeeded')`)
        .bind(at, at, row.invoice_id, row.id),
    );
    const audit = paidAudit(db, at, event, row);
    if (audit) statements.push(audit);
  } else if (event.type === 'checkout.session.completed') {
    // Checkout finished but the money has not settled yet, e.g. an ACH debit.
    statements.push(
      db
        .prepare(`UPDATE payments SET status = 'processing', stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
          updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(paymentIntentId, at, row.id),
      // Out-of-order delivery: if this payment already failed or succeeded, the invoice must not be
      // dragged into processing, where no later Stripe event would ever move it again.
      db
        .prepare(`UPDATE invoices SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'open'
          AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = 'processing')`)
        .bind(at, row.invoice_id, row.id),
    );
  } else if (event.type === 'checkout.session.async_payment_failed') {
    statements.push(
      db
        .prepare(`UPDATE payments SET status = 'failed', failed_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')`)
        .bind(at, at, row.id),
      // Only reopen the bill when no other payment for it is still in flight or already settled.
      db
        .prepare(`UPDATE invoices SET status = 'open', updated_at = ? WHERE id = ? AND status = 'processing'
          AND NOT EXISTS (SELECT 1 FROM payments WHERE invoice_id = ? AND id <> ? AND status IN ('processing', 'succeeded'))`)
        .bind(at, row.invoice_id, row.invoice_id, row.id),
    );
  } else {
    // checkout.session.expired: the customer never paid, the invoice stays as it was.
    statements.push(
      db
        .prepare(`UPDATE payments SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending'`)
        .bind(at, row.id),
    );
  }

  return commit(db, event, statements, 'applied');
}
