-- Production billing hardening: persist the Stripe Price that selected the plan.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

CREATE INDEX IF NOT EXISTS subscriptions_stripe_price_id_idx
  ON public.subscriptions(stripe_price_id);
