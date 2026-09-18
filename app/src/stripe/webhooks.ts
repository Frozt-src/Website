// Real Stripe signature verification. No hand-rolled cryptography, no API key needed.
import Stripe from 'stripe';
import type { StripeEvent, WebhookVerifier } from '../deps.ts';

export function stripeWebhookVerifier(webhookSecret: string): WebhookVerifier {
  // Workers expose WebCrypto only, so the signature has to be checked asynchronously.
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  return {
    async verify(payload: string, signatureHeader: string): Promise<StripeEvent> {
      const event = await Stripe.webhooks.constructEventAsync(
        payload,
        signatureHeader,
        webhookSecret,
        undefined,
        cryptoProvider,
      );
      // Kept whole rather than narrowed, so payment_events stores the entire payload.
      return event as unknown as StripeEvent;
    },
  };
}
