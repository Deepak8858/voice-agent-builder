# 06 — Database Schema

## Primary Database
Use PostgreSQL.

## Core Tables
```sql
users(id, external_auth_id, email, name, created_at, updated_at)
organizations(id, name, slug, owner_user_id, plan, status, created_at, updated_at)
workspaces(id, organization_id, parent_workspace_id, type, name, slug, status, created_at, updated_at)
memberships(id, user_id, workspace_id, role, created_at)
```

## Agent Tables
```sql
agents(id, workspace_id, name, description, industry, agent_type, status, active_version_id, created_by, created_at, updated_at)
agent_versions(id, agent_id, version_number, spec_json, provider, provider_runtime_id, deployment_status, created_by, created_at)
agent_templates(id, workspace_id, name, slug, industry, agent_type, description, template_spec, is_public, created_at, updated_at)
```

## Knowledge Tables
```sql
knowledge_sources(id, workspace_id, agent_id, source_type, title, file_url, status, metadata, created_by, created_at, updated_at)
knowledge_chunks(id, source_id, workspace_id, agent_id, chunk_index, content, embedding, metadata, created_at)
```

## Integration and Tool Tables
```sql
integrations(id, workspace_id, provider, display_name, status, encrypted_credentials, settings, created_by, created_at, updated_at)
agent_tools(id, agent_id, integration_id, name, description, input_schema, permissions, enabled, created_at)
tool_calls(id, call_id, workspace_id, agent_id, tool_name, input, output, status, error_message, started_at, ended_at)
```

## Contact and Compliance Tables
```sql
contacts(id, workspace_id, phone, email, full_name, metadata, opt_out, created_at, updated_at)
consent_records(id, workspace_id, contact_id, consent_type, source, proof_url, consented_at, expires_at, revoked_at, metadata, created_at)
dnc_entries(id, workspace_id, phone, source, created_at)
compliance_checks(id, workspace_id, agent_id, contact_id, call_id, direction, status, reasons, metadata, checked_at)
```

## Call Tables
```sql
calls(id, workspace_id, agent_id, agent_version_id, contact_id, provider, provider_call_id, direction, from_number, to_number, status, started_at, ended_at, duration_seconds, recording_url, transcript_text, outcome, cost_cents, metadata, created_at)
call_events(id, call_id, workspace_id, event_type, event_time, payload)
```

## Billing Tables
There is no `billing_accounts` and no `billing_usage`. Subscription state, the credit
ledger and the metered usage rows are separate tables, and the ledger is the money.

```sql
subscriptions(id, organization_id UNIQUE, dodo_subscription_id UNIQUE, dodo_customer_id, dodo_product_id, plan, catalog_version, status, concurrent_call_limit_override, current_period_start, current_period_end, cancel_at_period_end, trial_end, dodo_metadata, webhook_updated_at, created_at, updated_at)
billing_credit_buckets(id, organization_id, source_type, source_id, original_seconds, remaining_seconds, valid_from, expires_at, priority, status, dodo_payment_id, created_at, updated_at)
billing_ledger_entries(id, organization_id, bucket_id, workspace_id, call_id, entry_type, seconds, balance_after_seconds, actor_type, actor_id, reason_code, idempotency_key, metadata, created_at)
organization_credit_balances(id, organization_id UNIQUE, available_seconds, reserved_seconds, status, review_reason, version, created_at, updated_at)
call_usages(id, organization_id, workspace_id, call_id UNIQUE NULL, provider, provider_call_id, direction, dispatched_at, connected_at, ended_at, raw_connected_seconds, billable_seconds, reserved_seconds, debited_seconds, disposition, finalization_state, finalization_idempotency_key UNIQUE, created_at, updated_at)
runtime_usage_events(id, organization_id, call_id NULL, event_id, event_type, occurred_at, validated_payload, decision, claimed_at, attempt_count, processed_at, created_at)
usage_records(id, organization_id, workspace_id, billable_metric, quantity, period_start, period_end, recorded_at)
dodo_webhook_events(id, webhook_id UNIQUE, type, api_version, created, data, livemode, pending_webhooks, request_context, processing_started_at, attempt_count, processed_at, error_message, created_at)
```

Credit is held in **seconds**, never minutes. A bucket is granted credit with a
lifetime; the balance row is the fast-read total; every change to either is one
ledger entry.

`priority` orders spend: `10` = the plan's included allowance (`source_type`
`included`), `20` = a purchased minute pack (`source_type` `purchased`). Included
credit is always spent first and is forfeited, not rolled over, at period end.

### What makes a grant idempotent
Four constraints, and every one of them is load-bearing:

- `billing_ledger_entries UNIQUE (organization_id, idempotency_key)` is the gate.
  Keys are **derived, never random**: `stripe:invoice:<invoiceId>:included` for a
  subscription grant, `stripe:checkout:<sessionId>:topup` for a pack,
  `free_grant_<orgId>_<monthKey>` for the recurring Free allowance. A redelivered
  webhook recomputes the same key.
- `billing_credit_buckets UNIQUE (organization_id, source_type, source_id)` — the
  same invoice or session can only ever own one bucket.
- `billing_credit_buckets.dodo_payment_id UNIQUE` — a replayed checkout that
  slips past `dodo_webhook_events` collides on this index instead of minting a second
  paid-for bucket, and a refund or dispute can be mapped back to its grant by payment
  id alone.
- `call_usages.finalization_idempotency_key UNIQUE` and
  `runtime_usage_events UNIQUE (organization_id, event_id)` do the same for debits, so
  replay protection does not depend on the call row still existing.

On a key hit the grant is not silently accepted: the existing entry must match the
stored bucket's terms, compared against that bucket's own `original_seconds` rather
than today's catalog — otherwise repricing a pack would turn every historical
purchase into an idempotency conflict. `organization_credit_balances` is row-locked
(`SELECT ... FOR UPDATE`) for the whole grant and carries a monotonic `version`, so
concurrent grants for one organization serialize.

`call_usages.call_id` and `runtime_usage_events.call_id` are nullable and
`ON DELETE SET NULL` on purpose: the retention sweep deletes calls, and cascading
would destroy the evidence that a customer was charged.
`billing_ledger_entries.organization_id` is `ON DELETE RESTRICT` — the ledger blocks
its own deletion.

## White Label and Audit
```sql
white_label_settings(id, workspace_id, brand_name, logo_url, primary_color, custom_domain, support_email, hide_platform_branding, settings, created_at, updated_at)
audit_logs(id, workspace_id, organization_id, actor_user_id, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at)
```

## Tenant Rule
Every customer-owned table must contain `workspace_id` or be reachable through a workspace-scoped parent.
