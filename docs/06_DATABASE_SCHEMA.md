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

## Billing and White Label
```sql
billing_accounts(id, organization_id, stripe_customer_id, stripe_subscription_id, plan, status, created_at, updated_at)
billing_usage(id, organization_id, workspace_id, call_id, usage_type, quantity, unit, cost_cents, recorded_at)
white_label_settings(id, workspace_id, brand_name, logo_url, primary_color, custom_domain, support_email, hide_platform_branding, settings, created_at, updated_at)
audit_logs(id, workspace_id, actor_user_id, action, resource_type, resource_id, metadata, ip_address, user_agent, created_at)
```

## Tenant Rule
Every customer-owned table must contain `workspace_id` or be reachable through a workspace-scoped parent.
