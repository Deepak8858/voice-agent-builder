-- Seed plan_pricing table
-- Run this after migration to populate pricing data

INSERT INTO plan_pricing (id, plan, metric, price_per_unit, monthly_limit) VALUES
  (gen_random_uuid(), 'free', 'calls', 0, 0),
  (gen_random_uuid(), 'free', 'minutes', 0, 0),
  (gen_random_uuid(), 'starter', 'calls', 0.02, 500),
  (gen_random_uuid(), 'starter', 'minutes', 0.05, 500),
  (gen_random_uuid(), 'growth', 'calls', 0.015, -1),
  (gen_random_uuid(), 'growth', 'minutes', 0.04, 2000),
  (gen_random_uuid(), 'enterprise', 'calls', 0.01, -1),
  (gen_random_uuid(), 'enterprise', 'minutes', 0.03, -1)
ON CONFLICT (plan, metric) DO NOTHING;