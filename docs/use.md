# VoiceForge AI — Platform Usage Guide

Platform: AI voice agent builder for agencies and appointment-based businesses. Users describe needs in natural language; VoiceForge generates complete agents with voice persona, call flow, knowledge base, tools, compliance, analytics, and white-label client dashboards.

## Architecture

```
Next.js Frontend (port 3000)
  ↓
NestJS API (port 4000)
  ├─ Auth/Tenant Module
  ├─ Agent Builder Module
  ├─ Template Module
  ├─ Knowledge Module
  ├─ Voice Runtime Adapter (Vapi/Retell)
  ├─ Tool Registry
  ├─ Compliance Engine
  ├─ Call/Event Service
  ├─ Analytics Service
  ├─ Billing Service
  └─ Audit Service
  ↓
PostgreSQL (Supabase) + Redis (BullMQ)
```

---

## Phase Status

| Phase | Feature | Status |
|-------|---------|--------|
| 0 | Monorepo, NestJS, Next.js, Prisma, Redis, Auth | ✅ Complete |
| 1 | Agent Builder, Agent Spec JSON, CRUD, Mock Generator | ✅ Complete |
| 2 | Templates, Knowledge (PDF/CSV/upload), Embeddings | ✅ Complete |
| 3 | Voice Runtime (Vapi/Retell adapters), Browser Test | ⚠️ Partial |
| 4 | Publish, Webhook, Post-call Evaluations | ✅ Complete |
| 5 | Tool Registry, Webhooks, Google Calendar | ✅ Complete |
| 6 | Compliance (DNC, Consent, Opt-out) | ✅ Complete |
| 7 | Analytics, Improvement Suggestions | ✅ Complete |
| 8 | White Label, Client Workspaces | ✅ Complete |
| 9 | Stripe Billing, Usage Metering | ✅ Complete |
| 10 | Production Hardening | ⚠️ Partial |

---

## Getting Started

### Prerequisites

1. **Node.js** >= 20.11
2. **Supabase project** (free tier works)
   - Pooler connection string → `DATABASE_URL` (port `6543`, `?pgbouncer=true`)
   - Direct connection string → `DIRECT_URL` (port `5432`)
3. **Redis** (optional for queues)

### Setup

```powershell
# Copy env and fill in Supabase URLs
Copy-Item .env.example .env
# edit .env

# Install dependencies
npm install

# Push schema to Supabase
npm run db:generate
npm run db:push

# Seed MVP templates
npm run db:seed

# Run both apps
npm run dev
```

- API → http://localhost:4000/api/v1 (health: `/health`)
- Web → http://localhost:3000

### Voice Provider Setup (Optional)

For real voice calls, set environment variables:

```powershell
# Vapi
VOICE_PROVIDER=vapi
VAPI_API_KEY=your_key

# Retell
VOICE_PROVIDER=retell
RETELL_API_KEY=your_key
```

---

## Usage Flows

### 1. Agent Creation Flow

```
Sign up → Create workspace → /dashboard/agents/new
  → Paste prompt ("Create an AI receptionist for a dental clinic...")
  → Pick template (dental-receptionist, ai-receptionist, etc.)
  → Generate
  → Save as draft
  → View Agent Spec JSON in builder
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/agents/generate` — Generate agent from prompt
- `POST /api/v1/workspaces/:workspaceId/agents` — Create agent
- `GET /api/v1/workspaces/:workspaceId/agents` — List agents
- `PATCH /api/v1/workspaces/:workspaceId/agents/:agentId` — Update agent
- `POST /api/v1/workspaces/:workspaceId/agents/:agentId/versions` — Create version
- `POST /api/v1/workspaces/:workspaceId/agents/:agentId/publish` — Publish agent

### 2. Knowledge Base Flow

```
Builder → /dashboard/knowledge
  → Upload PDF, CSV, TXT, or Markdown files
  → Add text/URL sources
  → Automatic chunking and embedding
  → Search via retrieval endpoint
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/knowledge-sources/upload` — Upload file
- `POST /api/v1/workspaces/:workspaceId/knowledge-sources` — Create text/URL source
- `GET /api/v1/workspaces/:workspaceId/knowledge-sources` — List sources
- `GET /api/v1/workspaces/:workspaceId/knowledge-sources/search?query=...` — Semantic search

### 3. Testing & Calls Flow

```
Builder → /dashboard/agents/[agentId]/builder
  → Create test session (browser test)
  → Start outbound call
  → View call logs and transcripts
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/agents/:agentId/test-session` — Start test session
- `POST /api/v1/workspaces/:workspaceId/agents/:agentId/calls/outbound` — Start outbound call
- `GET /api/v1/workspaces/:workspaceId/calls` — List calls
- `GET /api/v1/workspaces/:workspaceId/calls/:callId` — Get call details
- `POST /api/v1/workspaces/:workspaceId/calls/:callId/end` — End call

### 4. Integrations Flow

```
/dashboard/integrations
  → Create webhook tool
  → Connect Google Calendar
  → View tool invocation logs
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/tools` — Create tool
- `GET /api/v1/workspaces/:workspaceId/tools` — List tools
- `POST /api/v1/workspaces/:workspaceId/tools/:toolId/invoke` — Invoke tool
- `GET /api/v1/workspaces/:workspaceId/tool-invocations` — View invocation logs

### 5. Compliance Flow

```
/dashboard/compliance
  → Add DNC entries
  → View consent records
  → Run compliance checks
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/compliance/check` — Run compliance check
- `GET /api/v1/workspaces/:workspaceId/compliance/dnc` — List DNC entries
- `POST /api/v1/workspaces/:workspaceId/compliance/dnc` — Add DNC entry
- `DELETE /api/v1/workspaces/:workspaceId/compliance/dnc/:phone` — Remove DNC entry

### 6. Analytics Flow

```
/dashboard/analytics
  → View workspace metrics
  → View agent metrics
  → View compliance metrics
  → Get improvement suggestions
```

**API Endpoints:**
- `POST /api/v1/workspaces/:workspaceId/analytics/events` — Record event
- `GET /api/v1/workspaces/:workspaceId/analytics/workspace` — Workspace metrics
- `GET /api/v1/workspaces/:workspaceId/analytics/agents` — Agent metrics
- `GET /api/v1/workspaces/:workspaceId/analytics/compliance` — Compliance metrics
- `GET /api/v1/workspaces/:workspaceId/analytics/agents/:agentId/suggestions` — Suggestions

### 7. White Label Flow

```
/dashboard/white-label
  → Configure branding (logo, colors, domain)
  → Create client workspaces
  → Invite clients
  → View client usage
```

**API Endpoints:**
- `GET /api/v1/workspaces/:workspaceId/white-label` — Get settings
- `PATCH /api/v1/workspaces/:workspaceId/white-label` — Update settings
- `POST /api/v1/workspaces/:workspaceId/clients` — Create client workspace
- `GET /api/v1/workspaces/:workspaceId/clients` — List clients
- `POST /api/v1/workspaces/:workspaceId/invites` — Create invite
- `GET /api/v1/workspaces/:workspaceId/invites` — List invites
- `POST /api/v1/invites/accept` — Accept invite

### 8. Billing Flow

```
/dashboard/billing
  → View subscription
  → View usage
  → Create checkout session
  → Create portal session
```

**API Endpoints:**
- `GET /api/v1/workspaces/:workspaceId/billing/subscription` — Get subscription
- `GET /api/v1/workspaces/:workspaceId/billing/usage` — Get usage metrics
- `POST /api/v1/workspaces/:workspaceId/billing/checkout` — Create checkout
- `POST /api/v1/workspaces/:workspaceId/billing/portal` — Create portal

---

## Key API Patterns

### Authentication

All endpoints require Clerk session cookie. Webhook endpoints use verification.

### Workspace Guard

Most endpoints use `WorkspaceGuard` requiring `workspaceId` path parameter and valid membership.

### Response Format

```json
// List endpoints
{ "items": [...] }

// Single item
{ ...itemData }

// Error
{ "statusCode": 400, "message": "...", "errorCode": "..." }
```

### Pagination

Standard pagination with `skip`/`take` query params.

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Supabase pooler connection | Yes |
| `DIRECT_URL` | Supabase direct connection | Yes |
| `REDIS_URL` | Redis for BullMQ queues | No |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anon key | Yes |
| `SUPABASE_JWT_SECRET` | Supabase JWT secret | Yes |
| `STRIPE_SECRET_KEY` | Stripe billing | No |
| `VAPI_API_KEY` | Vapi voice provider | No |
| `RETELL_API_KEY` | Retell voice provider | No |

---

## Known Limitations

1. **Browser Test Session**: Vapi does not expose browser-test API. Returns placeholder session.
2. **Outbound Calls**: Requires real Vapi/Retell assistant to be created first via publish flow.
3. **Embeddings**: Uses pgvector extension on Supabase for semantic search.
4. **Rate Limits**: Not yet fully implemented (Phase 10 pending).
5. **Observability**: Logs present but metrics/tracing not yet wired to external system.
6. **Backups**: Database backups rely on Supabase automatic backups.

---

## Database Models

- **User** — Auth users linked to Clerk
- **Organization** — Tenant org with plan/subscription
- **Workspace** — Agency/client workspace (direct/agency/client type)
- **Membership** — User-workspace roles
- **Agent** — Voice agent with spec JSON
- **AgentVersion** — Versioned agent specs
- **AgentTemplate** — Pre-built templates
- **KnowledgeSource** — Uploaded/linked knowledge
- **KnowledgeChunk** — Embedded chunks for retrieval
- **Call** — Call records
- **CallEvent** — Call lifecycle events
- **CallEvaluation** — Post-call scoring
- **IntegrationTool** — Webhook/Google Calendar tools
- **ToolInvocation** — Tool execution logs
- **Contact** — Phone contacts
- **ConsentRecord** — Consent tracking
- **DncEntry** — Do-not-call list
- **ComplianceCheck** — Compliance verification records
- **AnalyticsEvent** — Event tracking
- **WhiteLabelSettings** — Branding config
- **ClientInvite** — Client workspace invites
- **Subscription** — Stripe subscription
- **UsageRecord** — Billable usage tracking
- **GoogleCalendarConfig** — OAuth tokens for calendar
