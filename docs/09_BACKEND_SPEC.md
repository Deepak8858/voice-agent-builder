# 09 — Backend Specification

## Goal
Build a reliable multi-tenant backend for voice agent generation, deployment, calls, compliance, analytics, billing, and white-label agencies.

## Main Modules
```txt
auth, users, organizations, workspaces, agents, agent_versions, templates, knowledge, embeddings, integrations, tools, voice, calls, campaigns, compliance, analytics, billing, audit, webhooks
```

## Backend Rules
1. Controllers handle HTTP only.
2. Services contain business logic.
3. DTOs validate requests.
4. Workspace guard protects all workspace data.
5. Provider calls go through adapters.
6. Tool execution goes through tool registry.
7. Outbound calls go through compliance.
8. Webhooks use idempotency.
9. Mutations create audit logs.
10. Use structured errors.

## Key Services
- AgentBuilderService: generate/validate/save/compile agents.
- VoiceRuntimeService: provider adapter, test sessions, publish, webhooks.
- ComplianceService: consent, DNC/DND, opt-out, call window.
- ToolExecutionService: validate schema, permissions, execute integration.
- AnalyticsService: ingest events, aggregate metrics, evaluate calls.

## Error Codes
```txt
UNAUTHORIZED, FORBIDDEN, VALIDATION_ERROR, WORKSPACE_NOT_FOUND, AGENT_NOT_FOUND, AGENT_SPEC_INVALID, INTEGRATION_NOT_CONNECTED, COMPLIANCE_BLOCKED, VOICE_PROVIDER_ERROR, TOOL_EXECUTION_FAILED, BILLING_REQUIRED, RATE_LIMITED
```

## Workers
`knowledge.parse`, `knowledge.embed`, `webhook.retry`, `call.post_process`, `billing.sync`, `analytics.aggregate`, `agent.evaluate`.
