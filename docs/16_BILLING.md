# 16 — Billing and Usage

## Provider
Use Stripe.

## Plans
Starter: $49–$99/month, 1 agent, limited minutes, inbound only.
Pro: $199–$399/month, 3–5 agents, integrations, call recordings, opt-in outbound.
Agency: $499–$999/month, white-label, client workspaces, advanced analytics, usage markup reporting.

## Billable Units
voice minutes, published agents, seats, client workspaces, storage GB, premium integrations, custom domains later.

## Usage Record
```json
{
  "organization_id": "uuid",
  "workspace_id": "uuid",
  "call_id": "uuid",
  "usage_type": "voice_minutes",
  "quantity": 3.4,
  "unit": "minute",
  "cost_cents": 86
}
```

## Stripe Webhooks
checkout.session.completed, customer.subscription.created, customer.subscription.updated, customer.subscription.deleted, invoice.paid, invoice.payment_failed.

## Billing Safety
Use idempotency keys, do not double bill calls, reconcile provider duration, record provider cost and customer price separately, allow admin adjustments later.
