# VoiceForge AI — Path to 10/10

**Current Score: 5/10** | **Target: 10/10** | **139 tests passing, schema solid**

---

## Executive Summary

VoiceForge has real infrastructure with a comprehensive multi-tenant model, compliance engine, and 139 passing tests. Core gaps: broken HMAC webhooks, in-memory Maps (no horizontal scale), dead Twilio adapter, broken free tier, no demo audio, no pricing page, and a "visual flow builder" claim that doesn't exist in code.

**Biggest opportunity:** Agency white-label + programmatic SEO + own voice pipeline. None of Vapi/Retell/Bland/Synthflow have all three.

**Biggest risk:** Marketing claims product can't back. Every deception costs conversion.

---

## PHASE 1: CRITICAL SECURITY & RELIABILITY

**Timeline:** Week 1 | **Impact:** Security vulns eliminated, prod-ready

### 1.1 Fix Webhook HMAC — CRITICAL

**File:** `apps/api/src/calls/voice-webhook.controller.ts`

**Current bug:** `JSON.stringify(body)` after Express parses. Key order unstable → HMAC either bypassed or false-reject.

```ts
// main.ts — enable raw body
const app = await NestFactory.create(AppModule, { rawBody: true });

// voice-webhook.controller.ts
@Post(':provider')
@SkipRateLimit()
async receive(
  @Req() req: RawBodyRequest<Request>,
  @Headers('x-vapi-signature') sig: string | undefined,
  @Body() body: unknown,
) {
  const raw = req.rawBody; // ✅ exact bytes, no re-serialization
  const secret = env.VOICE_WEBHOOK_SECRET;
  
  if (!secret && isProduction()) {
    throw new UnauthorizedException('Missing webhook secret');
  }
  
  if (secret && sig) {
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
  
  await this.callsService.ingestEvent(provider, { event_type, provider_call_id, data: body });
  return { received: true };
}
```

Also: `VOICE_WEBHOOK_SECRET` must be required in production, not optional.

### 1.2 Persist Provider Runtime ID — CRITICAL

**Files:** `apps/api/src/voice/adapters/vapi.adapter.ts`, `apps/api/src/calls/calls.service.ts`

**Current bug:** `assistantIdMap` is in-memory `Map`. Node restart → all outbound calls fail with "No vapi assistant found".

```ts
// VapiVoiceAdapter.createAgent — write to DB, don't cache in Map
async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
  const assistant = await vapiRequest<{ id: string }>('POST', '/assistant', payload);
  
  await this.prisma.agentVersion.update({
    where: { id: input.agentVersionId },
    data: { providerRuntimeId: assistant.id },
  });
  
  return { provider_runtime_id: assistant.id };
  // Remove: this.assistantIdMap.set(...)
}

// calls.service.ts — resolve from DB, not Map
async startOutboundCall(...) {
  const version = await this.prisma.agentVersion.findUnique({
    where: { id: input.agentVersionId },
    select: { providerRuntimeId: true, agentId: true },
  });
  
  if (!version?.providerRuntimeId) {
    throw new AppError('RUNTIME_NOT_CREATED', 'Call createAgent before outbound', 400);
  }
  // Use providerRuntimeId directly — no Map lookup
}
```

### 1.3 JWT_SECRET Fail-Fast — CRITICAL

**File:** `apps/api/src/config/env.ts`

**Current bug:** `JWT_SECRET: z.string().default('change-me-in-development')`. Production accepts default.

```ts
JWT_SECRET: z.string().min(32).refine(
  (v) => isProduction() ? v !== 'change-me-in-development' : true,
  'JWT_SECRET must be a secure 32+ character string in production'
),

// main.ts at boot
if (isProduction() && env.JWT_SECRET === 'change-me-in-development') {
  throw new Error('FATAL: JWT_SECRET must be set in production');
}
```

### 1.4 Free Tier Fix — HIGH

**Files:** `packages/shared/src/schemas/billing.ts`, `apps/api/src/billing/billing.service.ts`

**Current bug:** Free plan = 0 minutes, 0 outbound. User can't test product.

**Fix:** 10 trial minutes, 5 trial outbound calls (consumable, not monthly limit):

```ts
// PLAN_LIMITS
free: {
  minutes: 10,          // trial minutes, not recurring
  outboundCalls: 5,    // trial calls, not monthly
  agents: 1,
  workspaces: 1,
  complianceBlocks: 10,
  tools: 2,
}
```

### 1.5 Vapi Model → gpt-4o-mini — HIGH

**File:** `apps/api/src/voice/adapters/vapi.adapter.ts`

**Current:** `model: 'gpt-4o'` — $5/$15 per M tokens.

**Fix:**
```ts
model: 'gpt-4o-mini', // ~$0.15/$0.60 per M — 10x cheaper
```

### 1.6 Idempotency on Outbound Call POST — HIGH

**File:** `apps/api/src/calls/calls.service.ts`

**Current bug:** No idempotency key. Double-click = double call = double charge.

```ts
// In startOutboundCall
async startOutboundCall(...) {
  // Check for duplicate within 60s
  const existing = await this.prisma.call.findFirst({
    where: { 
      workspaceId, 
      toNumber: dto.to_number,
      agentId,
      createdAt: { gt: new Date(Date.now() - 60000) },
    },
  });
  if (existing) return this.toSummary(existing);
  // ... proceed
}
```

### 1.7 Stripe Webhook Idempotency — HIGH

**File:** `apps/api/src/billing/billing.service.ts`

**Current bug:** No check for duplicate `stripeEventId` before processing.

```ts
async handleStripeEvent(event: Stripe.Event): Promise<void> {
  const existing = await this.prisma.stripeEvent.findUnique({
    where: { stripeEventId: event.id },
  });
  if (existing?.processedAt) return; // idempotent
  
  await this.prisma.$transaction(async (tx) => {
    await tx.stripeEvent.upsert({
      where: { stripeEventId: event.id },
      create: { stripeEventId: event.id, type: event.type, data: event.data.object as Json },
      update: {},
    });
    // ... process event
    await tx.stripeEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() },
    });
  });
}
```

---

## PHASE 2: DATA & INFRASTRUCTURE

**Timeline:** Weeks 2–3 | **Impact:** 100k user scale-ready

### 2.1 Partition UsageRecord & CallEvent by Month

**Migration:** Convert to Postgres native partitioning.

```sql
-- apps/api/prisma/migrations/partition_tables.sql

-- Usage records by month
ALTER TABLE usage_records PARTITION BY RANGE (date_trunc('month', recorded_at));

CREATE TABLE usage_records_2026_05 PARTITION OF usage_records 
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE usage_records_2026_06 PARTITION OF usage_records 
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Auto-create next month partition function
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS void AS $$
DECLARE
  next_month date := date_trunc('month', now()) + interval '1 month';
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS usage_records_%s PARTITION OF usage_records FOR VALUES FROM (%L) TO (%L)',
    to_char(next_month, 'YYYY_MM'),
    next_month::text,
    (next_month + interval '1 month')::text
  );
END;
$$ LANGUAGE plpgsql;

-- pg_cron: create next partition 1st of each month
SELECT cron.schedule('create-next-partition', '0 0 1 * *', $$SELECT create_monthly_partition()$$);
```

Same pattern for `call_events` and `analytics_events`.

### 2.2 Materialized Views for Usage & Analytics

**File:** `supabase/migrations/analytics_views.sql`

```sql
-- Monthly usage aggregation
CREATE MATERIALIZED VIEW mv_workspace_usage_monthly AS
SELECT 
  workspace_id,
  date_trunc('month', period_start) as period,
  billable_metric,
  SUM(quantity) as total_quantity,
  COUNT(*) as record_count
FROM usage_records
GROUP BY workspace_id, date_trunc('month', period_start), billable_metric;

CREATE UNIQUE INDEX ON mv_workspace_usage_monthly(workspace_id, period, billable_metric);

-- Agent daily stats
CREATE MATERIALIZED VIEW mv_agent_stats_daily AS
SELECT 
  agent_id,
  date_trunc('day', occurred_at) as day,
  event_type,
  COUNT(*) as count
FROM analytics_events
GROUP BY agent_id, date_trunc('day', occurred_at), event_type;

CREATE UNIQUE INDEX ON mv_agent_stats_daily(agent_id, day, event_type);

-- Refresh on cron, not on read
SELECT cron.schedule('refresh-analytics-mv', '0 * * * *', $$SELECT refresh_analytics_mv()$$);
```

### 2.3 Transcript Persistence

**File:** `apps/api/src/calls/calls.service.ts`

**Current bug:** `getTranscript` re-fetched from Vapi on every GET `/calls/:id`.

**Fix:** Persist on `call.ended` webhook:

```ts
// In ingestEvent() → call.ended block
const transcriptText = typeof payload.data?.transcript === 'string' 
  ? payload.data.transcript 
  : await this.voice.getTranscript({ callId: call.providerCallId })
    .then(t => t.transcript)
    .catch(() => null);

await this.prisma.call.update({
  where: { id: call.id },
  data: { transcriptText },
});
```

GET `/calls/:id` now reads from DB, not provider.

### 2.4 Index Optimizations

```sql
-- Missing indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_provider_call_id ON calls(provider_call_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_status ON calls(status) WHERE status IN ('in_progress', 'ringing');
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_versions_provider_runtime_id ON agent_versions(provider_runtime_id) WHERE provider_runtime_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_consent_records_expiring ON consent_records(workspace_id, consent_type) WHERE revoked_at IS NULL AND expires_at > now();
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_knowledge_chunks_embedding ON knowledge_chunks USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
```

---

## PHASE 3: CONVERSION OPTIMIZATION

**Timeline:** Weeks 2–3 | **Impact:** 3x+ signup conversion

### 3.1 Live Demo Audio on Landing — HIGHEST ROI

**File:** `apps/web/app/page.tsx`

Record a 30-sec demo call (dental office receptionist). Add to hero:

```tsx
// Hero section — add after CTA buttons
<div className="audio-player-wrapper relative mx-auto max-w-2xl mt-8">
  <div className="relative flex items-center gap-4 rounded-2xl border border-border/50 bg-card/80 p-4">
    <button 
      onClick={() => togglePlay()}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
    >
      {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
    </button>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium truncate">Dental receptionist — 30 sec call</p>
      <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
      </div>
    </div>
    <span className="shrink-0 text-xs text-muted-foreground font-mono">
      {formatTime(currentTime)} / {formatTime(duration)}
    </span>
  </div>
  <p className="mt-2 text-center text-xs text-muted-foreground">
    AI-generated call · Real voice agent · No humans involved
  </p>
</div>
```

Save recording to `public/demo/dental-receptionist-30s.mp3`.

### 3.2 Pricing Page — HIGHEST ROI

**File:** `apps/web/app/pricing/page.tsx`

```
/pricing with:
- Free: $0, 10 trial min, 1 agent, basic compliance
- Starter: $49/mo, 500 min, 5 agents, full compliance, email support
- Growth: $149/mo, 2000 min, unlimited agents, white-label, API access
- Enterprise: $499/mo, unlimited, dedicated support, SLA, HIPAA-ready

Each tier: feature comparison table + CTA to sign-up
Stripe Price IDs already exist — render them.
```

### 3.3 Public Agent Share Pages — VIRAL LOOP

**File:** `apps/web/app/a/[slug]/page.tsx`

```tsx
export default async function AgentSharePage({ params }: PageProps) {
  const agent = await getPublishedAgentBySlug(params.slug);
  
  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-accent/20">
      <div className="mx-auto max-w-2xl mt-16 p-8 rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-center gap-4 mb-6">
          <div className="h-16 w-16 rounded-xl bg-primary/10 flex items-center justify-center">
            <Mic2 className="h-8 w-8 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{agent.name}</h1>
            <p className="text-muted-foreground">{agent.spec.identity.business_name}</p>
          </div>
        </div>
        
        {/* Demo audio player */}
        <audio controls className="w-full" src={agent.demoAudioUrl} />
        
        {/* Sample transcript */}
        <div className="mt-6 p-4 rounded-lg bg-muted/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Sample Conversation
          </p>
          <div className="space-y-2 text-sm">
            {agent.sampleTranscript.map((turn, i) => (
              <div key={i} className={turn.speaker === 'agent' ? 'text-primary' : 'text-muted-foreground'}>
                <span className="font-medium">{turn.speaker === 'agent' ? 'Agent' : 'Caller'}:</span>
                <span className="ml-2">{turn.text}</span>
              </div>
            ))}
          </div>
        </div>
        
        <div className="mt-8 text-center">
          <Link href={`/sign-up?ref=${agent.slug}`}>
            <Button size="lg" className="gap-2">
              Build your own voice agent
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
```

### 3.4 Upgrade Modal on Limit Hit

**File:** `apps/web/components/billing/upgrade-modal.tsx`

Replace hard 403 with inline upsell:

```tsx
function UpgradeModal({ show, onClose }: { show: boolean; onClose: () => void }) {
  return (
    <Dialog open={show} onOpenChange={onClose}>
      <DialogContent>
        <div className="text-center py-4">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-chart-2/20">
            <TrendingUp className="h-6 w-6 text-chart-2" />
          </div>
          <h3 className="text-lg font-semibold">You've hit your limit</h3>
          <p className="mt-2 text-muted-foreground">
            Starter plan includes 500 minutes/month and unlimited agents.
          </p>
          <div className="mt-6 flex flex-col gap-3">
            <Button onClick={() => billing.createCheckoutSession({ priceId: STARTER_PRICE_ID })}>
              Upgrade to Starter — $49/mo
            </Button>
            <Button variant="outline" onClick={onClose}>
              Maybe later
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### 3.5 Streaming Agent Generation UX

**Files:** `apps/api/src/orchestrator/orchestrator.service.ts`, `apps/web/app/dashboard/agents/new/page.tsx`

```ts
// SSE endpoint for streaming generation
@Get(':workspaceId/agents/generate/stream')
async generateAgentStream(
  @Param('workspaceId') workspaceId: string,
  @Query('description') description: string,
) {
  const stream = new ReadableStream({
    async start(controller) {
      const llm = this.llmProvider.getLLM();
      const stream = await llm.stream({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: buildGenerationPrompt(description) }],
      });
      
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          controller.enqueue(`data: ${JSON.stringify({ token: event.delta.text })}\n\n`);
        }
      }
      
      controller.enqueue(`data: ${JSON.stringify({ done: true })}\n\n`);
      controller.close();
    },
  });
  
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
```

Frontend: token-by-token render with "thinking..." indicator.

### 3.6 Form Mode Editor

**Files:** `apps/web/components/agent-builder/form-mode/*.tsx`

Two-mode toggle in agent builder:

```
[JSON] [Form] ← toggle

Form mode sections:
├── Identity: agent name, business name, disclosure
├── Voice: tone dropdown, speaking rate slider, voice preview
├── Goals: multi-line textarea, add/remove goals
├── Required fields: dynamic form fields
├── Compliance: checkboxes for each feature
├── First message: textarea with live preview
└── Conversation rules: checkboxes for each rule
```

Schema already structured. Build form components that serialize/deserialize to JSON.

---

## PHASE 4: OWN VOICE RUNTIME

**Timeline:** Weeks 4–8 | **Impact:** Own latency story, margin protection

### 4.1 Architecture Overview

```
Audio Flow (<800ms p95 budget):
Twilio Media Streams (μ-law 8kHz)
  → Deepgram Nova-3 streaming (STT, ~150ms)
  → Claude Haiku 4.5 streaming (LLM TTFT ~200ms)
  → Cartesia Sonic-English (TTS, ~150ms)
  → μ-law encode → Twilio

Infrastructure:
apps/voice-edge/ — Fastify + @fastify/websocket
- Separate from NestJS API (not Express, not NestJS)
- Body parsers choke on binary audio
```

### 4.2 Twilio Media Streams Bridge

**File:** `apps/voice-edge/src/twilio-media-streams.ts`

```ts
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { Deepgram } from '@deepgram/sdk';

const fastify = Fastify();
await fastify.register(websocket);

fastify.get('/stream/:sessionId', { websocket: true }, async (socket, req) => {
  const sessionId = req.params.sessionId;
  
  // Twilio sends μ-law 8kHz → Deepgram needs 16-bit 16kHz PCM
  const resampler = new AudioResampler({
    from: { sampleRate: 8000, channels: 1, bits: 8, encoding: 'mulaw' },
    to: { sampleRate: 16000, channels: 1, bits: 16, encoding: 'pcm' },
  });
  
  const deepgram = new Deepgram(env.DEEPGRAM_API_KEY);
  const dgStream = await deepgram.transcribe.stream({
    model: 'nova-3',
    streaming: true,
    smart_format: true,
    punctuate: true,
  });
  
  socket.on('message', async (msg: Buffer) => {
    const pcm16 = resampler.convert(msg);
    dgStream.send(pcm16);
  });
  
  dgStream.on('transcript', async (result) => {
    if (result.is_final) {
      const text = result.channel.alternatives[0].transcript;
      await processLLMTurn(socket, text, sessionId);
    }
  });
});
```

### 4.3 LLM Orchestration

**File:** `apps/voice-edge/src/llm-orchestrator.ts`

```ts
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

async function processLLMTurn(socket: WebSocket, transcriptText: string, sessionId: string) {
  const session = await getSession(sessionId); // from Redis
  const spec = session.agentSpec;
  
  const response = await anthropic.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: buildSystemPrompt(spec),
    messages: [...session.conversationHistory, { role: 'user', content: transcriptText }],
  });
  
  let fullResponse = '';
  for await (const event of response) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      fullResponse += event.delta.text;
      streamTTS(socket, event.delta.text);
    }
  }
  
  await redis.rpush(`session:${sessionId}:history`, 
    JSON.stringify({ role: 'user', content: transcriptText }),
    JSON.stringify({ role: 'assistant', content: fullResponse })
  );
}
```

### 4.4 TTS Streaming

**File:** `apps/voice-edge/src/tts-stream.ts`

```ts
import { Cartesia } from '@cartesia/cartesia-node';

const cartesia = new Cartesia();

async function streamTTS(socket: WebSocket, text: string) {
  const stream = await cartesia.speech.stream({
    model: 'sonic-english',
    voice: { id: 'CLARA_VOICE_ID' },
    text,
    output_format: { container: 'raw', encoding: 'mulaw', sample_rate: 8000 },
  });
  
  for await (const chunk of stream) {
    socket.send(chunk); // μ-law 8kHz → send directly to Twilio
  }
}
```

### 4.5 Redis Session Management

**File:** `apps/voice-edge/src/session-store.ts`

```ts
import { Redis } from 'ioredis';

const redis = new Redis(env.REDIS_URL);

interface VoiceSession {
  agentId: string;
  agentVersionId: string;
  workspaceId: string;
  spec: AgentSpec;
  conversationHistory: Array<{ role: string; content: string }>;
}

// On call start
await redis.hset(`session:${sessionId}`, {
  agentId: version.agentId,
  agentVersionId: version.id,
  workspaceId: version.agent.workspaceId,
  spec: JSON.stringify(spec),
  startedAt: new Date().toISOString(),
});
await redis.expire(`session:${sessionId}`, 3600);
```

### 4.6 Deployment

```dockerfile
# apps/voice-edge/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

Add to `docker-compose.yml`:
```yaml
voice-edge:
  build: ./apps/voice-edge
  ports:
    - "8080:8080"
  environment:
    - REDIS_URL=${REDIS_URL}
    - DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}
    - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    - CARTESIA_API_KEY=${CARTESIA_API_KEY}
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
```

---

## PHASE 5: COMPLIANCE HARDENING

**Timeline:** Weeks 4–6 | **Impact:** Enterprise-ready, multi-language

### 5.1 E.164 Phone Normalization

**File:** `apps/api/src/compliance/compliance.service.ts`

**Current bug:** `normalizePhone` doesn't enforce E.164. Collisions possible.

**Fix:**
```ts
import { parsePhoneNumber } from 'libphonenumber-js';

function normalizePhone(phone: string, defaultCountry = 'US'): string | null {
  try {
    const parsed = parsePhoneNumber(phone, defaultCountry);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.format('E.164'); // +12125551234
  } catch {
    return null;
  }
}
```

Add migration to normalize existing phones:
```sql
UPDATE contacts SET phone = normalize_e164(phone);
```

### 5.2 Multi-Language Opt-Out Detection

**File:** `apps/api/src/compliance/compliance.service.ts`

**Current bug:** English-only opt-out detection.

**Fix:**
```ts
const OPT_OUT_PATTERNS = {
  en: ['stop calling', 'do not call', 'remove me', 'take me off', 'unsubscribe', 'opt out'],
  es: ['no me llames', 'no me llam', 'retirar del', 'quitarme de la lista'],
  fr: ['ne m\'appelez pas', 'me retirer', 'désabonner', 'arrêtez d\'appeler'],
  zh: ['别打电话', '取消订阅', '不要打电话'],
  pt: ['não me ligue', 'não me llam', 'retirar da lista'],
};
```

Detect contact language from metadata or call transcript language.

### 5.3 Recording Notice Boolean Flag

**File:** `packages/shared/src/schemas/agent-spec.ts`

**Current bug:** Recording notice check matches word `record` in goals. False positive.

**Fix:** Add dedicated field:
```ts
interface ComplianceConfig {
  recording_notice_required: boolean; // new — not derived from goals
  ai_disclosure_required: boolean;
  opt_out_enabled: boolean;
  dnc_check_enabled: boolean;
  consent_required: boolean;
}
```

Migration:
```sql
ALTER TABLE agent_versions 
ALTER COLUMN spec_json 
SET DEFAULT jsonb_set(spec_json, '{compliance,recording_notice_required}', 'false');
```

---

## PHASE 6: GROWTH & ENGAGEMENT

**Timeline:** Weeks 6–10 | **Impact:** Viral loops, retention

### 6.1 Referral System

**File:** `apps/api/src/referral/referral.service.ts`

```ts
interface Referral {
  referrerUserId: string;
  referredUserId: string;
  referrerWorkspaceId: string;
  bonusMinutes: number; // 100 free minutes for both
  status: 'pending' | 'converted' | 'expired';
}

// On invite acceptance:
async handleInviteAcceptance(inviteToken: string) {
  const invite = await this.prisma.clientInvite.findUnique({ where: { token: inviteToken } });
  
  // Credit referrer's workspace
  await this.billing.recordUsage(invite.agencyWorkspaceId, 'minutes', 100);
  
  // Credit new user's workspace
  await this.billing.recordUsage(newUserWorkspaceId, 'minutes', 100);
  
  await this.prisma.referral.create({
    data: { referrerUserId, referredUserId, referrerWorkspaceId, bonusMinutes: 100, status: 'pending' },
  });
}

// On first paid conversion: bonus 500 more to referrer
```

### 6.2 CSV Bulk Import + Campaign Launcher

**File:** `apps/web/app/dashboard/agents/[id]/campaigns/new/page.tsx`

```tsx
// Steps:
// 1. Upload CSV (name, phone, email)
// 2. Preview with validation errors
// 3. Schedule: max_calls_per_hour, max_concurrent
// 4. Compliance checklist
// 5. Launch

interface CampaignUpload {
  contacts: Array<{
    name: string;
    phone: string; // E.164 validated
    email?: string;
  }>;
  schedule: {
    maxCallsPerHour: number;
    maxConcurrent: number;
    startTime?: string;
    endTime?: string;
    daysOfWeek?: number[];
  };
}
```

### 6.3 Calendar Integrations

**File:** `apps/api/src/calendar/calendar.service.ts`

```ts
// Google Calendar OAuth
async connectGoogleCalendar(workspaceId: string, authCode: string) {
  const { tokens } = await oauth2Client.getToken(authCode);
  await this.prisma.googleCalendarConfig.upsert({
    where: { workspaceId },
    create: { workspaceId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenExpiry: new Date(tokens.expiry_date) },
    update: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, tokenExpiry: new Date(tokens.expiry_date) },
  });
}

// Tool for voice agent:
TOOL book_appointment(date: string, time: string, duration_minutes: number)
```

### 6.4 Weekly Digest Email

**File:** `apps/api/src/email/email.service.ts`

```ts
interface WeeklyDigest {
  stats: { totalCalls: number; totalMinutes: number; avgDuration: number; blockedRate: number; };
  bestAgent?: { name: string; calls: number; };
  complianceAlerts?: Array<{ reason: string; count: number; }>;
  upcomingCampaigns?: Array<{ name: string; scheduledCalls: number; }>;
}

// Cron: every Monday 9am
SELECT cron.schedule('weekly-digest', '0 9 * * 1', $$SELECT send_weekly_digest()$$);
```

---

## PHASE 7: ADVANCED UX

**Timeline:** Weeks 8–12 | **Impact:** Competitive parity with Retell/Vapi

### 7.1 Visual Flow Builder (Real)

**File:** `apps/web/components/flow-builder/flow-builder.tsx`

```tsx
import ReactFlow, { Node, Edge, Controls, Background } from 'reactflow';
import 'reactflow/dist/style.css';

interface FlowNode {
  type: 'start' | 'message' | 'question' | 'condition' | 'tool' | 'transfer' | 'end';
  data: Record<string, unknown>;
}

// Node types
// Start → Message (greeting) → Question (collect intent)
//   ├── Condition: intent == "appointment"
//   │   └── Tool: book_appointment → End
//   ├── Condition: intent == "hours"
//   │   └── Message → End
//   └── Default → Transfer → End

// Serialization to AgentSpec
function flowToSpec(nodes: Node[], edges: Edge[]): AgentSpec {
  // Topological sort → conversation_flow
  // Condition nodes → branching rules
  // Tool nodes → tools[]
  // Transfer nodes → escalation
}
```

### 7.2 Live Call Monitoring

**File:** `apps/web/app/dashboard/calls/[id]/page.tsx`

```tsx
function CallMonitor({ callId }: { callId: string }) {
  const [turns, setTurns] = useState<CallTurn[]>([]);
  
  useEffect(() => {
    const es = new EventSource(`/api/calls/${callId}/stream`);
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'turn') setTurns(prev => [...prev, data.turn]);
    };
    return () => es.close();
  }, [callId]);
  
  return (
    <div className="h-[400px] overflow-y-auto p-4 bg-muted rounded-lg font-mono text-sm">
      {turns.map((turn, i) => (
        <div key={i} className={`mb-4 ${turn.speaker === 'agent' ? 'text-primary' : ''}`}>
          <span className="text-xs text-muted-foreground">{turn.speaker} · {turn.at_ms}ms</span>
          <p className="mt-1">{turn.text}</p>
        </div>
      ))}
    </div>
  );
}
```

### 7.3 Multi-Language Support

```ts
interface VoiceConfig {
  language: string; // 'en-US' | 'es-ES' | 'fr-FR'
  voice_id: string; // Per-language voice preset
  speaking_rate: number;
}

// Spanish voice agent:
{ voice: { language: 'es-ES', voice_id: 'cristina', speaking_rate: 0.95 } }
```

---

## PHASE 8: ENTERPRISE & SCALE

**Timeline:** Months 4–6 | **Impact:** 100k+ user capable, enterprise-ready

### 8.1 Admin Cost Dashboard

```sql
CREATE MATERIALIZED VIEW mv_org_cost_summary AS
SELECT 
  o.id, o.name, o.plan,
  SUM(ur.quantity * p.price_per_unit) as estimated_cost,
  COUNT(DISTINCT ur.workspace_id) as active_workspaces,
  SUM(CASE WHEN ur.billable_metric = 'calls' THEN ur.quantity ELSE 0 END) as total_calls,
  SUM(CASE WHEN ur.billable_metric = 'minutes' THEN ur.quantity ELSE 0 END) as total_minutes
FROM organizations o
LEFT JOIN usage_records ur ON ur.organization_id = o.id
LEFT JOIN plan_pricing p ON p.plan = o.plan AND p.metric = ur.billable_metric
GROUP BY o.id, o.name, o.plan;
```

### 8.2 HIPAA + SOC2 Preparation

- Data retention policy: calls purged after 12 months (configurable)
- Encryption at rest: `ENCRYPTION_KEY` env var already exists
- Audit log export for compliance reporting
- GDPR: right-to-erasure (delete all contact data including calls)
- BAA with Vapi/Twilio

### 8.3 Multi-Region Deployment

```
Primary: Azure East US (low latency to Vapi/Twilio)
Secondary: Azure West Europe (EU customers)
Voice edge: Fly.io (closest to user)

Data:
- Primary DB: Supabase (East US)
- Read replicas: one per region
- Redis: Upstash (global, multi-region)
- Object storage: Supabase Storage (CDN-backed)
```

### 8.4 SDK + Public API

```yaml
# REST API v1
POST /v1/agents — create agent
GET /v1/agents/:id — get agent
POST /v1/agents/:id/calls — start outbound call
GET /v1/calls/:id — get call details
POST /v1/campaigns — create campaign

# Webhooks
- call.started
- call.ended
- call.blocked
- evaluation.completed

# Auth: API key (per-workspace)
# Rate limits: 100 req/min (starter), 1000 req/min (growth)
```

---

## PHASE 9: MOAT BUILDING

**Timeline:** Months 6–12 | **Impact:** Defensibility, market leadership

### 9.1 Programmatic SEO

Generate landing pages from `agent_templates`:

```
/templates/dental → "AI receptionist for dental clinics"
/templates/hvac → "AI appointment scheduler for HVAC companies"
/templates/real-estate → "AI voice agent for real estate agencies"
/templates/salon → "AI booking agent for salons & spas"
/templates/legal → "AI intake agent for law firms"

Each page:
- Vertical-specific demo audio
- Case study / testimonial
- Pricing with vertical discount
- "Book a demo" CTA
- FAQ for SEO
```

### 9.2 Template Marketplace

- Users publish templates (mark as public)
- Revenue share: 30% VoiceForge, 70% creator
- Template rating + reviews
- "Featured" curation

### 9.3 Agency CRM

```
/agency/dashboard:
- All client workspaces (agency → client hierarchy)
- Per-client: agent count, MRR, call volume, churn risk
- Aggregate revenue from agency perspective
- One-click add client workspace
- White-label portal link for each client
```

---

## CRITICAL PATH SUMMARY

```
WEEK 1 (5→5.5/10):
├── Fix webhook HMAC ← CRITICAL
├── Persist providerRuntimeId to DB ← CRITICAL
├── JWT_SECRET fail-fast ← CRITICAL
├── Free tier → 10 trial minutes ← HIGH
├── Vapi model → gpt-4o-mini ← HIGH
└── Add idempotency to outbound POST ← HIGH

WEEKS 2–3 (5.5→6.5/10):
├── Live demo audio on landing ← HIGHEST ROI
├── Pricing page + comparison table
├── Materialized views for usage/analytics
├── Partition UsageRecord + CallEvent by month
├── Form mode editor toggle
├── Streaming agent generation (SSE)
└── Stripe webhook idempotency

WEEKS 4–6 (6.5→7.5/10):
├── Own voice pipeline (Fastify + WS) ← MAJOR MOAT
├── E.164 phone normalization
├── Multi-language opt-out detection
├── Recording notice boolean flag
├── Public agent share pages
└── Upgrade modal on limit hit

WEEKS 7–10 (7.5→8.5/10):
├── Visual flow builder (React Flow) ← COMPETITIVE
├── Live call monitoring (SSE transcript)
├── Recording playback UI
├── CSV bulk import + campaign launcher
├── Calendar integrations (Google + Cal.com)
├── Weekly digest email
└── Referral system

MONTHS 4–6 (8.5→9.5/10):
├── Own SIP infrastructure (drop Twilio dependency)
├── Multi-region deployment
├── Admin cost dashboard
├── SDK + public API
├── HIPAA/SOC2 prep
└── Template marketplace

MONTHS 6–12 (9.5→10/10):
├── Programmatic SEO landing pages per vertical
├── Agency CRM dashboard
├── Competitive differentiation lock-in
└── Community + marketplace flywheel
```

---

## REMOVE IMMEDIATELY

1. **"Visual flow builder" claim** from landing page — doesn't exist in code
2. **Twilio adapter dead code** — or finish it. Don't ship fiction.
3. **"gpt-4o"** hardcoded in Vapi adapter — switch to gpt-4o-mini

---

## FINAL VERDICT

| | |
|---|---|
| **Achievable 10/10** | Yes. Technical foundation solid. Schema comprehensive. 139 tests pass. |
| **Biggest risk** | Parallel phases. Stick to critical path order. Week 1 fixes must ship first. |
| **Fastest path to 8/10** | Demo audio + pricing page + form-mode editor + streaming UX. 3 weeks. |
| **Biggest differentiator at 10/10** | Agency white-label + programmatic SEO + own voice pipeline. None of Vapi/Retell/Bland/Synthflow have all three. |
| **Success probability** | 15% as-is; 65% with Phase 1–3 complete; 90% with all phases complete |
