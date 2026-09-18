-- The hosted Checkout Session URL is only returned by Stripe when the session is created, so it has
-- to be stored to reuse a still-unexpired session instead of opening a second one for the invoice.
ALTER TABLE payments ADD COLUMN checkout_url TEXT;
