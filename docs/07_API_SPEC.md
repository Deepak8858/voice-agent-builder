# 07 — API Specification

## Base URL
`/api/v1`, set once by `app.setGlobalPrefix('api/v1')` in `apps/api/src/main.ts`.
Controllers must not repeat it: a `@Controller('v1/...')` is served at
`/api/v1/v1/...` and drags the doubled segment into the web app and the proxy
allow-list. No route does this any more — `AuditExportController` was the last
one and dropped its `v1/` segment, so the org audit log is served at
`/api/v1/orgs/:orgId/audit-logs`. `audit-export.controller.test.ts` pins the
declared path, so the doubling cannot come back unreviewed.

Paths below are relative to the prefix. This is the shape contract, not full
coverage of every route.

## Standard Response
```json
{ "success": true, "data": {}, "error": null }
```

## Workspaces
There is no workspace CRUD controller. The session's workspace arrives with the
user, client workspaces are created under their parent, and the only workspace
setting exposed is retention.
```http
GET   /auth/me
PATCH /workspaces/me/retention
GET   /workspaces/:workspaceId/clients
POST  /workspaces/:workspaceId/clients
GET   /workspaces/:workspaceId/clients/:clientWorkspaceId/usage
```

## Agents
```http
GET    /workspaces/:workspaceId/agents
POST   /workspaces/:workspaceId/agents
POST   /workspaces/:workspaceId/agents/generate
GET    /workspaces/:workspaceId/agents/:agentId
PATCH  /workspaces/:workspaceId/agents/:agentId
POST   /workspaces/:workspaceId/agents/:agentId/versions
POST   /workspaces/:workspaceId/agents/:agentId/publish
POST   /workspaces/:workspaceId/agents/:agentId/pause
PUT    /workspaces/:workspaceId/agents/:agentId/flow
```

## Generate Agent Payload
```json
{
  "prompt": "Create an AI receptionist for a dental clinic that books appointments and transfers emergencies.",
  "template_slug": "dental-receptionist",
  "business_context": { "business_name": "Smile Dental Clinic", "timezone": "America/Los_Angeles" }
}
```

## Templates
Read-only. There is no per-workspace template creation route.
```http
GET /templates
GET /templates/:templateSlug
```

## Knowledge
The resource is `knowledge-sources`, not `knowledge`, and there is no `/faq` route —
an FAQ is a source like any other.
```http
GET    /workspaces/:workspaceId/knowledge-sources
POST   /workspaces/:workspaceId/knowledge-sources
POST   /workspaces/:workspaceId/knowledge-sources/upload
POST   /workspaces/:workspaceId/knowledge-sources/search
GET    /workspaces/:workspaceId/knowledge-sources/:sourceId
PATCH  /workspaces/:workspaceId/knowledge-sources/:sourceId
DELETE /workspaces/:workspaceId/knowledge-sources/:sourceId
POST   /workspaces/:workspaceId/knowledge-sources/:sourceId/reindex
POST   /workspaces/:workspaceId/knowledge-sources/backfill
GET    /workspaces/:workspaceId/agents/:agentId/knowledge-sources
```

## Voice Testing
A test session is a call, so it is ended through the calls resource.
```http
POST /workspaces/:workspaceId/agents/:agentId/test-session
POST /workspaces/:workspaceId/calls/:callId/end
```

## Calls
Transcript and events are not separate endpoints: the transcript is a field on the
call, and events stream over SSE from `/live`. Outbound dialling is keyed by the
agent that places the call.
```http
GET  /workspaces/:workspaceId/calls
GET  /workspaces/:workspaceId/calls/:callId
GET  /workspaces/:workspaceId/calls/:callId/live
POST /workspaces/:workspaceId/calls/:callId/end
POST /workspaces/:workspaceId/agents/:agentId/calls/outbound
```

## Compliance
```http
POST /workspaces/:workspaceId/compliance/check
POST /workspaces/:workspaceId/compliance/dnc
POST /workspaces/:workspaceId/contacts/:contactId/consent
POST /workspaces/:workspaceId/contacts/:contactId/opt-out
```

## Integrations and Tools
There is no `integrations` resource. Tools are workspace-scoped, not agent-scoped,
and each provider connection has its own controller.
```http
GET    /workspaces/:workspaceId/tools
POST   /workspaces/:workspaceId/tools
GET    /workspaces/:workspaceId/tools/:toolId
PATCH  /workspaces/:workspaceId/tools/:toolId
DELETE /workspaces/:workspaceId/tools/:toolId
POST   /workspaces/:workspaceId/tools/:toolId/invoke
GET    /workspaces/:workspaceId/tool-invocations
GET    /workspaces/:workspaceId/google/status
GET    /workspaces/:workspaceId/google/authorize
DELETE /workspaces/:workspaceId/google/disconnect
GET    /workspaces/:workspaceId/calendar/status
POST   /workspaces/:workspaceId/calendar/connect
DELETE /workspaces/:workspaceId/calendar/disconnect
```

## API Rules
Every route validates workspace access. Every mutation logs audit event. Every outbound call runs compliance check. Every webhook is idempotent. Never expose encrypted credentials.
