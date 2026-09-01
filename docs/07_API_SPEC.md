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

## Authorization and Roles
Workspace membership carries one of four roles: `owner`, `admin`, `editor`,
`viewer`. On workspace-scoped routes (`:workspaceId` in the path, or
`@SessionScoped` routes reading `active_workspace_id`), reads require
membership only (any role) and mutations carry an explicit
`@RequiredRole(...)` allow-list enforced by `RoleGuard` — so on these routes a
`viewer` can read and never mutate. The mapping is machine-checked, not
maintained here: `security/route-guard-baseline.test.ts` fails the build for
any workspace mutation without a role gate, so the decorators in the
controllers are the authoritative per-route matrix.

The tiers in use on role-gated workspace routes:

- **owner, admin** — configuration, money, and destructive operations:
  billing, telephony/phone numbers, tools CRUD, compliance/DNC, CRM routing,
  campaigns, white-label, workspace audit log, retention settings, and
  contact erasure (`DELETE /workspaces/me/contacts/:contactId/erasure`).
  Destructive routes (contact erasure, campaign start, knowledge
  delete/backfill, retention change) additionally use `{ fresh: true }`,
  which re-resolves the membership row instead of trusting the cached role.
- **owner, admin, editor** — day-to-day authoring: agents CRUD/publish/flow,
  knowledge-source writes, test sessions, outbound calls, tool invocation,
  Google connection management.

Org-scoped routes (`/orgs/:orgId/...`) use `@RequiredOrgRole(...)` read by
`OrganizationGuard` — `@RequiredRole` deliberately throws on org routes.

Routes outside the workspace-role model, each with its own authorization:

- `DELETE /users/me/erasure` — account self-deletion, called from the
  Settings page. Authenticated by the verified Supabase session; the user id
  comes from the session, never the path, so there is no cross-user surface
  and no workspace role to check. The service refuses (rather than deletes)
  when the account's organization has other members, a live subscription, or
  retained financial records.
- Knowledge `search` (read-shaped POST) and analytics `record` (ingestion):
  membership only.
- White-label `invites/accept`: the invite token is the authorization.
- Calendar `connect`/`disconnect`: internal-key caller, no membership row.

## API Rules
Every route validates workspace access. Every mutation logs audit event. Every outbound call runs compliance check. Every webhook is idempotent. Never expose encrypted credentials.
