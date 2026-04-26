# 07 — API Specification

## Base URL
`/api/v1`

## Standard Response
```json
{ "success": true, "data": {}, "error": null }
```

## Workspaces
```http
GET    /workspaces
POST   /workspaces
GET    /workspaces/:workspaceId
PATCH  /workspaces/:workspaceId
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
```http
GET /templates
GET /templates/:templateSlug
POST /workspaces/:workspaceId/templates
```

## Knowledge
```http
POST   /workspaces/:workspaceId/knowledge
POST   /workspaces/:workspaceId/knowledge/faq
GET    /workspaces/:workspaceId/knowledge
DELETE /workspaces/:workspaceId/knowledge/:sourceId
POST   /workspaces/:workspaceId/knowledge/:sourceId/reindex
```

## Voice Testing
```http
POST /workspaces/:workspaceId/agents/:agentId/test-sessions
POST /workspaces/:workspaceId/test-sessions/:testSessionId/end
```

## Calls
```http
GET  /workspaces/:workspaceId/calls
GET  /workspaces/:workspaceId/calls/:callId
GET  /workspaces/:workspaceId/calls/:callId/transcript
GET  /workspaces/:workspaceId/calls/:callId/events
POST /workspaces/:workspaceId/calls/outbound
```

## Compliance
```http
POST /workspaces/:workspaceId/compliance/check
POST /workspaces/:workspaceId/compliance/dnc
POST /workspaces/:workspaceId/contacts/:contactId/consent
POST /workspaces/:workspaceId/contacts/:contactId/opt-out
```

## Integrations and Tools
```http
GET  /workspaces/:workspaceId/integrations
POST /workspaces/:workspaceId/integrations/:provider/connect
POST /workspaces/:workspaceId/integrations/:integrationId/test
GET  /workspaces/:workspaceId/agents/:agentId/tools
POST /workspaces/:workspaceId/agents/:agentId/tools
POST /workspaces/:workspaceId/agents/:agentId/tools/:toolId/test
```

## API Rules
Every route validates workspace access. Every mutation logs audit event. Every outbound call runs compliance check. Every webhook is idempotent. Never expose encrypted credentials.
