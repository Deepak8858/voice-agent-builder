# VoiceForge AI — Agent Generation + Multi-CRM Platform

## Spec Version: 1.0 | Date: 2026-05-10

---

## 1. Overview

### What this platform does

VoiceForge AI is a multi-tenant SaaS platform enabling agencies to build voice calling AI agents from a natural language prompt, connect multiple CRMs with rules-based routing, upload documents that auto-wire into the agent's knowledge base, and deploy inbound/outbound calling with full analytics and white-label.

### Target users

- Agencies managing multiple client accounts
- Appointment-based businesses (dental, HVAC, salon, real estate)
- Sales teams needing AI lead qualification + CRM logging
- Customer support teams for inbound call handling

### How it differs from competitors (Vapi, Bland AI, etc.)

| Feature | Vapi / Bland AI | VoiceForge |
|---|---|---|
| Agent creation | API-first, manual | Prompt-to-agent in one shot |
| CRM | Single CRM per agent | Multi-CRM with rules fan-out |
| Documents | Separate upload step | Inline during generation |
| Routing | Static | Dynamic keyword-based |
| White-label | Enterprise only | All tiers |
| Cost | $0.05-0.14/min | $0.06-0.10/min + subscription |

---

## 2. Architecture

### Stack (existing, no changes)

- **Frontend:** Next.js 16.2.4 + React 19 + Tailwind 4 + Xyflow + Monaco
- **Backend:** NestJS 10 + Prisma 5.22 + BullMQ 5 + Redis
- **Database:** Supabase Postgres + pgvector
- **Auth:** Clerk
- **LLM:** Anthropic Claude Sonnet 4.6 (swappable via env)
- **Billing:** Stripe

### New Components

```
apps/api/src/
  orchestrator/          NEW — AgentOrchestrator service
    orchestrator.module.ts
    orchestrator.service.ts
    orchestrator.controller.ts
    dto/
      generate-agent.dto.ts
      generate-status.dto.ts

  twilio-adapter/        NEW — Twilio voice provider adapter
    twilio.adapter.ts
    twilio.module.ts
    twilio.service.ts
    twilio-webhook.controller.ts

  crm-routing/           NEW — Multi-CRM rules engine
    crm-routing.service.ts
    crm-routing.module.ts
    dto/
      routing-rule.dto.ts

  crm-fanout/            NEW — Fan-out executor
    crm-fanout.service.ts
    crm-fanout.module.ts

  knowledge-pipeline/     NEW — Doc ingest pipeline
    knowledge-pipeline.service.ts
    knowledge-pipeline.module.ts

  tools-auto/            NEW — Auto-provision tools
    tools-auto.service.ts
    tools-auto.module.ts

  voice-pipeline/        NEW — Twilio + Deepgram call pipeline
    voice-pipeline.service.ts
    audio-streamer.ts
    call-session.manager.ts
```

### Voice Provider Architecture (replacing Vapi/Retell)

```
INBOUND CALL FLOW:
Twilio (PSTN) → WebSocket → Deepgram STT → LLM (Claude) → Deepgram TTS → WebSocket → Twilio → Caller

OUTBOUND CALL FLOW:
Agent trigger → Twilio outbound call → WebSocket → same pipeline above

COMPONENTS:
- Twilio Account: handles phone numbers, SIP, PSTN routing
- TwiML webhooks: receives inbound calls, establishes WebSocket connection
- Deepgram: real-time STT (Nova-3) + TTS (Aura-2)
- LLM: Claude Sonnet 4.6 processes transcript, returns response
- VoicePipelineService: manages WebSocket connections, audio streaming, session state
```

---

## 3. Agent Generation Flow

### Trigger

Agency user submits prompt + config via frontend form (prompt box + structured overrides).

### Input

```typescript
interface GenerateAgentRequest {
  prompt: string;                    // "AI receptionist for dental clinic, books appointments, confirms insurance"
  template_slug?: string;           // optional: "dental-receptionist" etc.
  crm_providers: ('pipedrive' | 'hubspot' | 'salesforce')[];
  call_direction: 'inbound' | 'outbound' | 'both';
  voice_config?: {
    provider: 'deepgram' | 'elevenlabs' | 'custom';
    voice_id?: string;
    language?: string;
    stability?: number;
  };
  uploaded_docs?: File[];           // PDF, CSV, TXT
  custom_routing_rules?: RoutingRule[];
  white_label?: boolean;
}
```

### Orchestration Steps (AgentOrchestrator)

**Step 1 — LLM Generation (Sync, ~5-10 sec)**

```
Input: prompt + template_slug + business_context
Output: DraftAgentSpec + suggested_routing_rules + suggested_name

- LLM parses industry keyword → CRM routing rules
- LLM parses call direction → inbound/outbound/both
- LLM parses goals → conversation flow + tools
- LLM suggests: agent name, voice config, personality, greeting
- Output validated against AgentSpecSchema (existing)
```

**Step 2 — Save Draft Agent (Sync)**

```
- Agent saved as status: 'draft_generating'
- Frontend receives agent ID + status endpoint
- Split view UI activates immediately
```

**Step 3 — Doc Ingest (Async, BullMQ job)**

```
Trigger: upload files attached to generation request

Process:
1. Files stored in S3 or local storage (workspace-scoped)
2. PDF/CSV/TXT parsed → text chunks (existing pdf-parse)
3. Chunks → OpenAI embeddings via existing embed service
4. pgvector insert with agent_id link
5. On complete: agent spec updated with knowledge_config
6. Agent status → 'draft_docs_ready'

Background split view: shows progress "Ingesting documents... 3/5 files processed"
```

**Step 4 — CRM Tools Auto-Provision (Async)**

```
Trigger: CRM providers selected in request

Process:
1. Per CRM provider: create integration tool in DB
2. Link tools to agent spec tools list
3. Fan-out routing rules stored in crm_routing_rules table
4. Workspace-level CRM credentials already configured in workspace settings
5. On complete: agent status → 'draft_crm_ready'

Error handling: if CRM creds missing → warn user, mark partial
```

**Step 5 — Twilio Number Provisioning (Async)**

```
Trigger: call_direction includes 'inbound' or 'both'

Process:
1. Check workspace Twilio config
2. If BYO: validate number ownership via Twilio API
3. If platform-provisioned: buy number from Twilio ($1.15/mo)
4. Configure TwiML webhook → point to voice-pipeline endpoint
5. Associate number with agent
```

**Step 6 — Publish**

```
Trigger: user clicks "Publish" (or auto-publish after all steps complete)

Process:
1. Final validation of agent spec
2. Compile runtime config for Twilio adapter
3. Create/update agent in Twilio (if outbound calls enabled)
4. Agent status → 'published'
5. Event: analytics.agent.published
```

### Split View UX

```
┌─────────────────────────────────────────────────────┐
│ Agent Builder                              [Publish] │
├──────────────────────────┬──────────────────────────┤
│ AGENT PREVIEW            │ DOCUMENT PROCESSING       │
│ ───────────────────      │ ──────────────────       │
│ Name: Dental Receptionist│ [========    ] 60%       │
│ Industry: Healthcare     │ "Processing your PDFs..."│
│ Voice: Aura-2 (female)   │                           │
│                          │ 3 of 5 files done         │
│ Identity:                │                           │
│ "You are a friendly..."  │ [Uploaded:]              │
│                          │ - services.pdf ✓          │
│ Goals:                   │ - pricing.pdf ✓           │
│ • Book appointments      │ - insurance.pdf ...      │
│ • Confirm insurance      │ - faq.docx ...            │
│ • Answer FAQs            │ - brochure.txt ...        │
│                          │                           │
│ CRM Routing:             │ [Ready!] ✓                │
│ dental → Pipedrive       │                           │
│ insurance_q → HubSpot   │                           │
│                          │                           │
│ [Edit Spec]              │ [View Knowledge Base]     │
└──────────────────────────┴──────────────────────────┘
```

---

## 4. Voice Pipeline — Twilio + Deepgram

### Call Flow

```
[Inbound Call]
     ↓
Twilio receives call on provisioned number
     ↓
Twilio sends webhook to /voice/webhook/inbound
     ↓
VoicePipelineService creates CallSession
     ↓
Twilio connects WebSocket for audio streaming
     ↓
Audio stream → Deepgram STT → transcript chunks
     ↓
Transcript chunks → LLM (Claude) with system prompt
     ↓
LLM response → Deepgram TTS → audio chunks
     ↓
Audio chunks → Twilio WebSocket → caller
     ↓
On tool call: execute tool, inject result into LLM context
     ↓
On end: save transcript + recording + analytics event
```

### Outbound Flow

```
[Outbound Trigger]
     ↓
AgentOrchestrator or API calls voice-pipeline.startOutbound(agent_id, phone_number)
     ↓
Twilio makes outbound call via REST API
     ↓
On answer: Twilio connects to same WebSocket pipeline
     ↓
Same STT → LLM → TTS flow
```

### Twilio Adapter Interface

```typescript
interface VoiceRuntimeProvider {
  createAgent(config: RuntimeAgentConfig): Promise<string>;
  updateAgent(agentId: string, config: RuntimeAgentConfig): Promise<void>;
  deleteAgent(agentId: string): Promise<void>;
  startOutboundCall(agentId: string, to: string, metadata?: CallMetadata): Promise<string>;
  endCall(callId: string): Promise<void>;
  transferCall(callId: string, to: string): Promise<void>;
  getTranscript(callId: string): Promise<Transcript>;
  getRecording(callId: string): Promise<string>; // URL
  createBrowserTestSession(agentId: string): Promise<BrowserTestSession>;
  // Webhook handlers
  handleInboundCallWebhook(payload: any): Promise<void>;
  handleCallStatusWebhook(payload: any): Promise<void>;
}
```

### WebSocket Session Manager

```
CallSession {
  id: string
  agent_id: string
  call_sid: string
  direction: 'inbound' | 'outbound'
  status: 'initiating' | 'streaming' | 'ended'
  started_at: Date
  transcript: TranscriptSegment[]
  tools_used: ToolResult[]
  crm_logs: CrmFanOutResult[]
  metadata: Record<string, any>
}

AudioStreamer {
  - manages Twilio WebSocket connection
  - sends audio to Deepgram
  - receives STT results, forwards to LLM
  - receives LLM text, sends to Deepgram TTS
  - receives TTS audio, sends to Twilio
  - handles interruptions (caller vs agent speech)
  - manages hold/mute/transfer signals
}
```

### Twilio Configuration Required

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER_PREFIX=+1
TWILIO_SIP_DOMAIN=              # optional, for SIP calls
TWILIO_TWIML_WEBHOOK_URL=https://your-domain.com/voice/webhook/inbound
TWILIO_STATUS_WEBHOOK_URL=https://your-domain.com/voice/webhook/status
```

### Deepgram Configuration Required

```
DEEPGRAM_API_KEY=
DEEPGRAM_STT_MODEL=nova-3       # Monaural, best quality
DEEPGRAM_TTS_VOICE=aura-2-en-us
DEEPGRAM_TTS_MODEL=aura-2
```

---

## 5. Multi-CRM Routing — Rules Engine

### Routing Rule Structure

```typescript
interface RoutingRule {
  id: string;
  workspace_id: string;
  agent_id?: string;           // null = applies to all agents in workspace
  keyword: string;             // "dental", "enterprise", "appointment"
  crm_provider: 'pipedrive' | 'hubspot' | 'salesforce';
  action: 'primary' | 'secondary';  // primary = always fan-out here first
  contact_mapping: {
    full_name?: string;        // which transcript field maps to
    phone?: string;
    email?: string;
    company?: string;
    notes?: string;
    custom_fields?: Record<string, string>;
  };
  priority: number;             // lower = evaluated first
  active: boolean;
}
```

### Fan-Out Logic

```
When: LLM determines "create contact" tool call
Input: parsed contact data from LLM output

1. Find all matching rules where keyword appears in agent spec industry/goals
2. Sort by priority
3. First rule = primary → call primary CRM, get contact_id
4. Secondary rules → call secondary CRMs (if primary succeeded)
5. Aggregate results: { primary_contact_id, secondary_contact_ids, status }

Conflict resolution: if same contact exists in multiple CRMs,
use primary CRM contact_id as canonical, others just get linked

Error handling:
- Primary fails → retry once → if still fails, log error, continue
- Secondary fails → log error, don't block
- Return partial success: { success: true, primary_id: "...", secondary_errors: [...] }
```

### Default Rules Auto-Generated from Industry

```
Industry Keyword → Default CRM Routing

"dental", "dentist", "clinic" → Pipedrive (primary), HubSpot (secondary)
"hvac", "plumbing", "repair" → Pipedrive (primary)
"real estate", "realtor" → HubSpot (primary)
"medical", "healthcare", "doctor" → Salesforce (primary), HubSpot (secondary)
"enterprise", "b2b", "saas" → Salesforce (primary), HubSpot (secondary)
"salon", "spa", "beauty" → Pipedrive (primary)
```

LLM generates these automatically during agent spec generation based on industry keyword detection.

---

## 6. Document Ingestion Pipeline

### Supported Formats

- PDF (via pdf-parse — existing)
- CSV (auto-parse, first row = headers)
- TXT (direct chunk)
- DOCX (future)
- URL/web scraping (future)

### Chunking Strategy

```typescript
interface KnowledgeChunk {
  id: string;
  knowledge_source_id: string;
  agent_id: string;
  content: string;          // actual text, max 500 chars
  embedding: number[];      // 1536-dim OpenAI ada2
  metadata: {
    source_file: string;
    page_number?: number;
    chunk_index: number;
    total_chunks: number;
  };
}

// Chunking: 500 char sliding window, 50 char overlap
// Target: ~100-500 chunks per PDF depending on size
```

### Embedding Flow

```
File upload → parse → chunk → OpenAI ada-2 embedding → pgvector insert

Async job per file:
- job.data = { agent_id, file_url, file_type }
- On complete: emit 'knowledge.ingest.complete'
- AgentOrchestrator receives event, updates agent spec knowledge_config
```

### Knowledge Config in Agent Spec

```typescript
// Added to AgentSpecSchema
interface KnowledgeConfig {
  enabled: boolean;
  sources: {
    id: string;
    name: string;
    type: 'pdf' | 'csv' | 'txt' | 'url';
    chunk_count: number;
    added_at: Date;
  }[];
  retrieval_config: {
    top_k: number;          // default 5
    min_similarity: number; // default 0.7
    rerank: boolean;        // default false
  };
  auto_refresh: boolean;     // daily background job refreshes chunks
}
```

---

## 7. Tool Auto-Provisioning

### Existing Tool Registry (no changes)

Tool registry + webhook executor already exist. This adds auto-wiring.

### Auto-Provision Flow

```
When: CRM providers selected during agent generation

For each CRM provider:
1. Check if integration tool already exists in workspace
   - Query: integration_tools WHERE workspace_id = X AND provider = Y
2. If exists: link tool_id to agent spec
3. If not: create new tool
   - Name: "Create CRM Contact via [Provider]"
   - Type: 'crm'
   - Provider: the CRM provider
   - Config: workspace-level credentials (API key, etc.)
   - Input schema: { full_name, phone, email, notes, company }

For Google Calendar:
1. Check if tool exists for workspace
2. If not: create tool with workspace OAuth credentials
3. Link to agent spec if calendar booking is a goal
```

### Tool Execution at Runtime

```
During call, LLM decides: "create contact for John Smith"
→ ToolRegistry.getTool('crm_create_contact')
→ CrmExecutor.execute({ tool: 'pipedrive', data: {...} })
→ CrmRoutingService.apply_routing_rules(industry, goals)
→ Fan out to matching CRMs
→ Return result to LLM → LLM continues conversation
```

---

## 8. Phone Number Management

### Number Types

| Type | Cost/mo | Provision |
|---|---|---|
| US Local | $1.15 | Platform buys from Twilio |
| US Toll-free | $2.15 | Platform buys from Twilio |
| BYO Twilio | $0 | Agency connects their account |
| BYO Existing | $0 | Agency provisions existing number |

### Number Provisioning Flow

```
User: enable inbound calls
↓
Check: does workspace have Twilio credentials?
  → No: show "Connect your Twilio account" (BYO flow)
  → Yes: show number picker
↓
Platform-provisioned:
  - List available area codes
  - User picks area code
  - Buy number from Twilio: POST /v1/AvailablePhoneNumbers
  - Purchase: POST /v1/IncomingPhoneNumbers
  - Configure webhook: POST /v1/Accounts/{sid}/Phones/{number_sid}
    → voice_webhook_url = https://domain.com/voice/webhook/inbound
    → status_webhook_url = https://domain.com/voice/webhook/status
↓
BYO:
  - User enters Twilio Account SID + Auth Token
  - Validate: make test API call
  - List existing numbers
  - User assigns number to agent
  - User updates Twilio webhook in their Twilio console
```

### Per-Agent Number Assignment

```
agent.phone_number_id → links to twilio_phone_numbers table

One number = one agent (at launch)
Future: one number = multiple agents via IVR (Phase 2)
```

---

## 9. CRM Connections (Workspace-Level)

### Existing: Workspace model

Workspaces already exist. CRM connections stored at workspace level.

### New Tables

```sql
-- CRM provider credentials (encrypted)
workspace_crm_credentials {
  id: uuid
  workspace_id: uuid → FK workspaces
  provider: enum('pipedrive', 'hubspot', 'salesforce')
  credentials: jsonb  -- encrypted API keys, tokens
  config: jsonb        -- provider-specific settings
  status: enum('active', 'invalid', 'pending')
  last_tested_at: timestamp
  created_at: timestamp
}

-- Routing rules
crm_routing_rules {
  id: uuid
  workspace_id: uuid → FK workspaces
  agent_id: uuid? → FK agents (null = workspace-wide)
  keyword: string
  provider: enum('pipedrive', 'hubspot', 'salesforce')
  action: enum('primary', 'secondary')
  priority: int
  active: boolean
  created_at: timestamp
}

-- Fan-out log (audit)
crm_fanout_log {
  id: uuid
  call_id: uuid → FK calls
  agent_id: uuid
  contact_data: jsonb
  fanout_results: jsonb  -- { provider, success, contact_id, error }
  created_at: timestamp
}
```

### CRM Settings Page

```
Workspace Settings → CRM Connections

┌─────────────────────────────────────────────┐
│ CRM Connections                             │
│                                             │
│ [Pipedrive] ● Connected                    │
│ API Key: ●●●●●●●●●●●●●  [Test] [Disconnect]│
│ Status: Valid (last tested 2 hours ago)    │
│                                             │
│ [HubSpot] ○ Not Connected                   │
│ [Connect HubSpot]                          │
│ Note: Used as secondary for healthcare     │
│                                             │
│ [Salesforce] ● Connected                   │
│ Instance: mycompany.my.salesforce.com       │
│ Consumer Key: ●●●●●●●●●●  [Test] [Disconnect]
│                                             │
│ [+ Add Custom CRM]                         │
└─────────────────────────────────────────────┘
```

---

## 10. Call Modes

### Inbound

- Agent gets a phone number
- Prospect calls number
- Twilio routes to WebSocket
- Agent answers, conversation happens
- Agent creates contact in CRM based on routing rules
- Call ends, transcript + recording saved

### Outbound

- Agency uploads CSV of contacts OR connects CRM (pulls leads)
- Agent initiates calls (batch or triggered)
- For each call: Twilio dials → prospect answers → WebSocket connects → conversation
- Agent creates contact in CRM
- Call ends, transcript + recording saved

### Outbound Campaign Management

```typescript
interface OutboundCampaign {
  id: string;
  agent_id: string;
  name: string;
  contacts: {
    phone: string;
    full_name?: string;
    email?: string;
    custom_data?: Record<string, string>;
  }[];
  schedule: {
    start_time: Date;
    end_time: Date;
    max_calls_per_hour: number;
    max_concurrent: number;
    retry_failed: boolean;
    retry_count: number;
  };
  status: 'draft' | 'running' | 'paused' | 'completed';
}
```

---

## 11. Persona Model (Hybrid)

### At Publish Time

```
Agent spec frozen as version
- System prompt locked
- Identity locked
- Goals locked
- Tool list locked
```

### Knowledge Refresh (Daily Background Job)

```
Cron: every 24 hours
For each published agent:
1. Re-embed knowledge chunks (if source docs updated)
2. Update similarity scores
3. Log: knowledge_refresh_complete
```

### Knowledge Injection at Runtime

```
Per conversation turn:
1. Retrieve relevant chunks from pgvector (top_k=5, min_similarity=0.7)
2. Inject as context: [KNOWLEDGE CONTEXT]\n{chunk_1}\n{chunk_2}\n...[/KNOWLEDGE CONTEXT]
3. LLM uses this alongside frozen system prompt
```

---

## 12. Pricing Model

### Cost Stack (per active call minute)

| Component | Provider | Cost/min |
|---|---|---|
| Twilio PSTN outbound | Twilio | $0.014 |
| Twilio PSTN inbound | Twilio | $0.0085 |
| Deepgram STT | Nova-3 | $0.0048 |
| Deepgram TTS | Aura-2 | $0.03 |
| Claude Sonnet 4.6 | ~4000 tokens/call | $0.03 |
| **Total** | | **~$0.08-0.10** |

### Subscription Tiers

| Tier | Monthly | Included mins | Overage/min | Target |
|---|---|---|---|---|
| Starter | $49 | 150 | $0.28 | Small agencies, 1-2 clients |
| Growth | $179 | 600 | $0.20 | Mid-size, 3-5 clients |
| Scale | $499 | 2,000 | $0.12 | Large, 10+ clients |
| Enterprise | Custom | Unlimited | Custom | Big volume |

### Included in All Tiers

- Agent builder (prompt-to-agent)
- CRM integrations (Pipedrive, HubSpot, Salesforce, generic webhook)
- Multi-CRM routing with rules engine
- Knowledge base + document upload
- Compliance engine (DNC, consent, audit)
- Analytics dashboard
- White-label branding
- Split-view generation UX
- Inbound + outbound calling
- Twilio + Deepgram voice pipeline

### Add-Ons

| Add-on | Price | Notes |
|---|---|---|
| Extra phone number | $1.15/mo | Platform-provisioned |
| Extra CRM connection | $15/mo | Beyond standard 3 |
| Custom domain (white-label) | $50/mo | Full white-label |
| Extra agent seats | $15/seat/mo | Additional users |
| Priority support | $99/mo | 4-hour response |

### Revenue Margins

| Tier | Infrastructure cost | Price charged | Margin |
|---|---|---|---|
| Starter (150 min) | $12 | $49 | **75%** |
| Growth (600 min) | $48 | $179 | **73%** |
| Scale (2000 min) | $160 | $499 | **68%** |

### Chat Channel

- Chat-based agent interface included free in all tiers
- Same agent, different channel (voice vs text)
- No additional infrastructure cost
- Chat transcript logged to same analytics system

---

## 13. Database Schema Changes

### New Tables

```sql
-- Workspace CRM credentials
CREATE TABLE workspace_crm_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  provider VARCHAR(20) NOT NULL CHECK (provider IN ('pipedrive', 'hubspot', 'salesforce', 'generic_webhook')),
  credentials JSONB NOT NULL,  -- encrypted
  config JSONB,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('active', 'invalid', 'pending')),
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(workspace_id, provider)
);

-- CRM routing rules
CREATE TABLE crm_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  keyword VARCHAR(100) NOT NULL,
  provider VARCHAR(20) NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('primary', 'secondary')),
  priority INT DEFAULT 100,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_crm_routing_workspace ON crm_routing_rules(workspace_id);
CREATE INDEX idx_crm_routing_agent ON crm_routing_rules(agent_id) WHERE agent_id IS NOT NULL;

-- CRM fan-out log
CREATE TABLE crm_fanout_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID REFERENCES calls(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  contact_data JSONB NOT NULL,
  fanout_results JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_crm_fanout_call ON crm_fanout_log(call_id);

-- Twilio phone numbers (new, replaces ad-hoc storage)
CREATE TABLE twilio_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  phone_number VARCHAR(20) NOT NULL UNIQUE,
  type VARCHAR(20) DEFAULT 'local' CHECK (type IN ('local', 'tollfree', 'byo')),
  twilio_sid VARCHAR(100),
  inbound_webhook_url VARCHAR(500),
  status VARCHAR(20) DEFAULT 'active',
  cost_per_month NUMERIC(6,2) DEFAULT 1.15,
  provisioned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_twilio_workspace ON twilio_phone_numbers(workspace_id);
CREATE INDEX idx_twilio_agent ON twilio_phone_numbers(agent_id) WHERE agent_id IS NOT NULL;

-- Outbound campaigns
CREATE TABLE outbound_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  name VARCHAR(200) NOT NULL,
  contacts JSONB NOT NULL,
  schedule JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'paused', 'completed', 'failed')),
  stats JSONB DEFAULT '{"total": 0, "completed": 0, "failed": 0, "in_progress": 0}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_campaign_workspace ON outbound_campaigns(workspace_id);
CREATE INDEX idx_campaign_agent ON outbound_campaigns(agent_id);
```

### Agent Status Enum Update

```sql
-- Extend existing agent status enum
ALTER TYPE agent_status ADD VALUE IF NOT EXISTS 'draft_generating';
ALTER TYPE agent_status ADD VALUE IF NOT EXISTS 'draft_docs_ready';
ALTER TYPE agent_status ADD VALUE IF NOT EXISTS 'draft_crm_ready';
ALTER TYPE agent_status ADD VALUE IF NOT EXISTS 'publishing';
```

### Agent Spec Schema Update

Add `knowledge_config` and `crm_routing_config` to AgentSpecSchema (in `packages/shared/src/schemas/agent-spec.ts`).

---

## 14. Frontend Changes

### New Pages

| Page | Route | Purpose |
|---|---|---|
| Agent Builder (new) | `/dashboard/agents/new` | Split-view generation UI |
| Agent Editor | `/dashboard/agents/[id]/edit` | Edit existing agent |
| CRM Settings | `/dashboard/settings/crm` | Workspace-level CRM connections |
| CRM Routing Rules | `/dashboard/settings/crm/rules` | Configure routing rules |
| Phone Numbers | `/dashboard/settings/phone-numbers` | Manage Twilio numbers |
| Outbound Campaigns | `/dashboard/campaigns` | List + manage outbound campaigns |
| Campaign Detail | `/dashboard/campaigns/[id]` | View campaign stats |

### Agent Builder Page Layout

```
/apps/web/app/dashboard/agents/new/page.tsx

┌─────────────────────────────────────────────────────────────┐
│ ← Back to Agents                    "Build New Agent"       │
├──────────────────────────────┬──────────────────────────────┤
│                              │                              │
│  PROMPT & CONFIG             │  GENERATED PREVIEW           │
│                              │                              │
│  [Prompt textarea]            │  Agent Name: [auto-filled]   │
│  "Describe your agent..."    │  Industry: [auto-detected]   │
│                              │  Goals: [auto-list]           │
│  CRM Providers:              │  Voice: [config]              │
│  ☑ Pipedrive                 │  CRM Routing:                │
│  ☑ HubSpot                   │  [keyword → CRM rules]       │
│  ☐ Salesforce                │                              │
│                              │  Tools:                       │
│  Call Direction:             │  • CRM Contact [Pipedrive]    │
│  ○ Inbound  ● Both  ○ Outbound│  • CRM Contact [HubSpot]     │
│                              │  • Calendar Booking           │
│  Voice: [Deepgram ▼]         │                              │
│  Language: [English ▼]      │  [Doc Processing Panel]       │
│                              │  [3/5 files ready]            │
│  [Upload Documents]          │                              │
│  [Drop PDF, CSV, TXT]        │  [Publish Agent] button       │
│                              │                              │
└──────────────────────────────┴──────────────────────────────┘
```

### Backend API Endpoints (new)

```
POST   /api/agents/generate           — Start generation flow
GET    /api/agents/generate/:id       — Get generation status
POST   /api/agents/:id/publish        — Publish agent
POST   /api/agents/:id/regenerate     — Regenerate from new prompt

GET    /api/workspace/crm-credentials  — List CRM connections
POST   /api/workspace/crm-credentials — Add CRM connection
PUT    /api/workspace/crm-credentials/:id — Update CRM creds
DELETE /api/workspace/crm-credentials/:id — Remove CRM
POST   /api/workspace/crm-credentials/:id/test — Test connection

GET    /api/workspace/crm-routing-rules — List routing rules
POST   /api/workspace/crm-routing-rules  — Create rule
PUT    /api/workspace/crm-routing-rules/:id — Update rule
DELETE /api/workspace/crm-routing-rules/:id — Delete rule

GET    /api/workspace/phone-numbers   — List Twilio numbers
POST   /api/workspace/phone-numbers/provision — Buy new number
POST   /api/workspace/phone-numbers/byo  — Add BYO number
PUT    /api/workspace/phone-numbers/:id  — Update number (assign to agent)
DELETE /api/workspace/phone-numbers/:id — Release number

GET    /api/campaigns                — List outbound campaigns
POST   /api/campaigns                — Create campaign
GET    /api/campaigns/:id            — Get campaign detail
PUT    /api/campaigns/:id            — Update campaign (pause, resume)
DELETE /api/campaigns/:id            — Delete campaign
POST   /api/campaigns/:id/run        — Start campaign
POST   /api/campaigns/:id/pause       — Pause campaign
```

---

## 15. Implementation Order

### Phase 1: Core Infrastructure
1. Create `twilio.adapter.ts` (replace Retell stub)
2. Create `VoicePipelineService` (WebSocket + Deepgram)
3. Create `CallSessionManager`
4. Twilio webhook controllers
5. Test: make a real inbound call

### Phase 2: Orchestration Layer
6. Create `AgentOrchestrator` service
7. Create `GenerateAgentDto` and status endpoints
8. Connect LLM generator → orchestrator
9. Test: prompt → draft spec

### Phase 3: Doc Pipeline
10. Create `KnowledgePipelineService`
11. BullMQ job for doc ingest
12. Split view UI — document processing panel
13. Test: upload PDF → knowledge chunks

### Phase 4: CRM Wiring
14. Create `CrmRoutingService`
15. Create `CrmFanOutService`
16. Auto-provision tools from CRM selection
17. CRM settings page (workspace-level)
18. Test: create contact → fan-out to 2 CRMs

### Phase 5: Phone Numbers
19. Twilio number provisioning service
20. Phone numbers management page
21. Number assignment to agents
22. Test: buy number + assign to agent

### Phase 6: Outbound Campaigns
23. Outbound campaign model + API
24. Campaign management UI
25. Batch call runner (BullMQ)
26. Test: upload CSV → make 10 calls

### Phase 7: Full Integration
27. End-to-end test: prompt → agent → docs → CRM → call
28. Analytics pipeline updates
29. Billing integration (usage metering)
30. Production hardening

---

## 16. Open Questions / Future Phases

### Phase 2 considerations
- **IVR routing**: one phone number → multiple agents (menu selection) — not in scope for V1
- **Twilio SIP**: connect desk phones for human handoff — future
- **Custom JS routing rules**: Option D from brainstorming — ask agencies if needed
- **Custom CRM provider**: generic webhook covers most cases, dedicated adapters for high-demand CRMs later
- **Call recording storage**: S3 vs Supabase storage — decide based on volume

### Competitive differentiators to emphasize
1. **One-shot prompt → working agent** — competitors require manual API setup
2. **Multi-CRM fan-out** — nobody else does this
3. **Split-view generation** — see agent while docs process
4. **Rules-based routing** — dynamic, not static CRM assignment
5. **White-label on all tiers** — competitors gate this behind enterprise

---

*Spec authored via brainstorming process. Approved by user on 2026-05-10.*