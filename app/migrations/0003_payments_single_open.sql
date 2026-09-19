-- One invoice may have at most one payment still in flight, so it can never have two live Stripe
-- Checkout Sessions. Two concurrent checkout requests race on this index rather than on process
-- memory: the one that loses the insert waits for the winner's url instead of opening its own.
CREATE UNIQUE INDEX payments_one_open ON payments(invoice_id) WHERE status IN ('pending', 'processing');
