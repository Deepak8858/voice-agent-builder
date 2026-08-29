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
  ├─ Voice Runtime Adapter (OpenAI Realtime / in-house Azure pipeline)
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
| 3 | Voice Runtime (OpenAI Realtime + in-house Azure pipeline), Browser Test | ⚠️ Partial |
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

For real voice calls, set environment variables. Vapi and Retell were removed in
2026-08; the two supported runtimes are OpenAI Realtime and the in-house Azure
`standard` pipeline (Azure Speech STT → Azure OpenAI chat → Azure Speech TTS).

```powershell
# OpenAI Realtime
VOICE_PROVIDER=openai-realtime
OPENAI_API_KEY=your_key

# In-house "standard" pipeline (the only runtime the free plan may use)
VOICE_STANDARD_PIPELINE_ENABLED=true
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your_key
AZURE_VOICE_LLM_DEPLOYMENT=your_deployment
AZURE_SPEECH_KEY=your_key
AZURE_SPEECH_REGION=your_region
```

#### Plan-to-pipeline routing

A paid plan does **not** imply OpenAI Realtime. `PipelineRouterService`
(`apps/api/src/voice/pipeline-router.service.ts`) derives the runtime from the
plan's `pipelineMix` in `packages/shared/src/billing/catalog.ts`:

- **free** — 100% `standard`. Never routed to Realtime.
- **starter** — 50/50 split. The pipeline is chosen per call by a SHA-256 hash of
  the call ID, so roughly half of starter calls run on the in-house pipeline and
  the decision is stable for a given call across retries and webhooks.
- **growth**, **enterprise** — 100% `realtime`.

The decision is persisted on `Call.pipeline`, so retries, webhooks, and
reconciliation all agree on what actually ran.

When `VOICE_STANDARD_PIPELINE_ENABLED` is off:

- **starter** falls back to Realtime for every call (it has bought Realtime
  capability, so this costs margin but never breaks a call).
- **free** has no runtime at all; the router still reports `standard` with reason
  `standard_pipeline_disabled` and the call is refused upstream with a 503 rather
  than being silently upgraded to Realtime.

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

All endpoints require a Supabase Auth session. The browser holds the Supabase
session cookie; the Next.js server extracts the access token and sends it to the
API as `Authorization: Bearer` plus `x-internal-key`, and the API verifies the
JWT. Webhook endpoints use signature verification instead.

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
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (web app) | Yes |
| `INTERNAL_API_KEY` | Shared secret the web app sends as `x-internal-key` | Yes |
| `SUPABASE_JWT_SECRET` | Verifies session JWTs locally | One of this or `SUPABASE_SERVICE_ROLE_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role ops; also the remote token-verification fallback | One of this or `SUPABASE_JWT_SECRET` |
| `STRIPE_SECRET_KEY` | Stripe billing | No |
| `OPENAI_API_KEY` | OpenAI Realtime runtime (all growth/enterprise calls and the Realtime half of starter) | No |
| `VOICE_STANDARD_PIPELINE_ENABLED` | Enables the in-house Azure pipeline used by every free-plan call and roughly half of starter-plan calls | No |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_VOICE_LLM_DEPLOYMENT` | Voice brain for the in-house pipeline | If the pipeline is enabled |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | STT and TTS for the in-house pipeline | If the pipeline is enabled |

---

## Known Limitations

1. **Browser Test Session**: The runtime follows the same plan routing as calls. Free-plan tests join a LiveKit room on the in-house pipeline and are metered against the plan's monthly minutes; starter tests land on either runtime according to the deterministic split; growth/enterprise tests use an OpenAI Realtime session. When LiveKit or the pipeline router is unavailable, tests fall back to Realtime so local development keeps working.
2. **Outbound Calls**: Require a published agent and a connected telephony provider; the free plan has no PSTN entitlement.
3. **Embeddings**: Uses pgvector extension on Supabase for semantic search.
4. **Rate Limits**: Not yet fully implemented (Phase 10 pending).
5. **Observability**: Logs present but metrics/tracing not yet wired to external system.
6. **Backups**: Database backups rely on Supabase automatic backups.

---

## Database Models

- **User** — Auth users linked to a Supabase Auth user via `auth_user_id`
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
