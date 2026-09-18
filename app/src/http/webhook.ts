// Stripe webhook endpoint on the pay host. The signature is the only authentication.
import type { Handler } from 'hono';
import type { AppDeps } from '../deps.ts';
import { applyStripeEvent } from '../domain/payments.ts';

const maxBodyBytes = 64 * 1024;

export function stripeWebhookHandler(deps: AppDeps): Handler {
  return async c => {
    const declaredLength = Number(c.req.header('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return c.json({ error: 'payload_too_large' }, 413);
    }

    const payload = await c.req.text();
    if (new TextEncoder().encode(payload).length > maxBodyBytes) {
      return c.json({ error: 'payload_too_large' }, 413);
    }

    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'invalid_signature' }, 400);

    let event;
    try {
      event = await deps.webhooks.verify(payload, signature);
    } catch (error) {
      // The payload and the signature header are never logged.
      deps.logError('webhook_signature_failed', error);
      return c.json({ error: 'invalid_signature' }, 400);
    }

    // An unexpected database failure throws on to the 500 handler, so that Stripe retries.
    const { outcome } = await applyStripeEvent(deps.db, deps, event);
    return c.json({ received: true, outcome });
  };
}
