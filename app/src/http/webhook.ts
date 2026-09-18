// Stripe webhook endpoint on the pay host. The signature is the only authentication.
import type { Handler } from 'hono';
import type { AppDeps } from '../deps.ts';
import { applyStripeEvent } from '../domain/payments.ts';

const maxBodyBytes = 64 * 1024;

// Read the body as it arrives and give up as soon as it passes the cap, so an unannounced (chunked)
// oversized payload is never buffered whole. Returns null when the cap is exceeded.
async function readCappedBody(request: Request): Promise<string | null> {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBodyBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function stripeWebhookHandler(deps: AppDeps): Handler {
  return async c => {
    const payload = await readCappedBody(c.req.raw);
    if (payload === null) return c.json({ error: 'payload_too_large' }, 413);

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
