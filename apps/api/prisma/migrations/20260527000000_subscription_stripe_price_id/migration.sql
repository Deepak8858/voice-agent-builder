-- Persist the Stripe Price selected for a subscription plan.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;

CREATE INDEX IF NOT EXISTS subscriptions_stripe_price_id_idx
  ON public.subscriptions(stripe_price_id);
