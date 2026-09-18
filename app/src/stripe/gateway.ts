// Production Stripe adapter. Only index.ts wires this; tests inject fakes through AppDeps.
import Stripe from 'stripe';
import type { CheckoutSessionInput, StripeGateway } from '../deps.ts';

export function stripeGateway(secretKey: string): StripeGateway {
  const stripe = new Stripe(secretKey, {
    apiVersion: Stripe.API_VERSION,
    // Workers have no Node http module; fetch is the supported transport.
    httpClient: Stripe.createFetchHttpClient(),
  });

  return {
    async createCheckoutSession(input: CheckoutSessionInput) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          client_reference_id: input.invoiceId,
          customer_email: input.customerEmail,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency,
                unit_amount: input.amountCents,
                product_data: {
                  name: `Invoice ${input.invoiceNumber}`,
                  // Stripe rejects an empty description, so an invoice without one sends none.
                  description: input.description || undefined,
                },
              },
            },
          ],
          metadata: {
            invoice_id: input.invoiceId,
            invoice_number: input.invoiceNumber,
            payment_id: input.paymentId,
          },
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          expires_at: input.expiresAt,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      if (!session.url) throw new Error('stripe returned a checkout session without a url');
      return { id: session.id, url: session.url };
    },
  };
}
