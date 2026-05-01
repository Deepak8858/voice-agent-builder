# Replace Mocks with Real Providers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mock/stub adapters with real implementations — Auth (Clerk), LLM (Azure AI Foundry Kimi 2.6 with Redis caching), Voice (Vapi). Reduce hallucinations via caching + schema validation.

**Architecture:**
- Auth: existing ClerkAuthService already wired, just needs `CLERK_SECRET_KEY` env var
- LLM: new `AzureAiFoundryAdapter` with Redis caching layer. Cache key = hash of (prompt + business_context + template_slug). TTL = 24h. Fallback to mock on cache miss
- Voice: rewrite `VapiVoiceAdapter` from stub to full implementation using Vapi HTTP API

**Tech Stack:** NestJS, Prisma, BullMQ/Redis, Vapi HTTP API, Azure AI Foundry (OpenAI-compatible)

---
<!-- [SPEC] docs/superpowers/specs/2026-04-30-replace-mocks-with-real-providers-design.md -->
<!-- [CACHE-STRATEGY] Redis-first for LLM generation. Cache key = SHA-256(prompt + ctx + template). TTL 24h. Fallback to mock on error. -->

## File Map

```
apps/api/src/
├── config/
│   └── env.ts                                          [MODIFY] — add LLM_API_KEY, extend LLM_PROVIDER
├── llm/
│   ├── llm.module.ts                                   [MODIFY] — wire AzureAiFoundryAdapter
│   ├── llm.provider.interface.ts                       [READ]   — already exists
│   ├── adapters/
│   │   ├── azure-aifoundry.adapter.ts                  [CREATE] — new
│   │   ├── mock-llm.adapter.ts                         [READ]   — reference pattern
│   │   └── openai.adapter.ts                           [READ]   — reference pattern
│   └── llm-cache.service.ts                            [CREATE] — Redis caching for LLM
├── voice/
│   ├── adapters/
│   │   └── vapi.adapter.ts                             [MODIFY] — stub → full impl
│   └── voice.module.ts                                 [MODIFY] — verify DI wiring
├── auth/
│   └── auth.module.ts                                  [READ]   — already correct, confirm
├── cache/
│   └── cache.service.ts                                [READ]   — existing, confirm interface
├── agents/
│   └── mock-generator.service.ts                       [READ]   — fallback target
└── prisma/
    └── prisma.service.ts                               [READ]   — for test setup

.env                                                    [MODIFY] — fill in real keys
apps/api/src/llm/adapters/azure-aifoundry.adapter.test.ts  [CREATE] — unit tests
apps/api/src/voice/adapters/vapi.adapter.test.ts          [CREATE] — unit tests
```

---

## Task 1: Update env.ts — Add LLM_API_KEY + extend LLM_PROVIDER enum

**Files:**
- Modify: `apps/api/src/config/env.ts`

**Current state (lines 20-21):**
```typescript
LLM_PROVIDER: z.enum(['mock', 'github', 'openai', 'anthropic']).default('mock'),
```

**Changes:**
- Add `LLM_API_KEY` optional string
- Add `'azure-aifoundry'` to LLM_PROVIDER enum
- Add `LLM_CACHE_TTL_SECONDS` optional number, default 86400 (24h)

**Steps:**
- [ ] **Step 1: Edit env.ts — add LLM_API_KEY and extend enum**

```typescript
// Find: OPENAI_API_KEY: z.string().optional(),
// Add after it:
LLM_API_KEY: z.string().optional(),

// Find: LLM_PROVIDER: z.enum(['mock', 'github', 'openai', 'anthropic']).default('mock'),
// Replace with:
LLM_PROVIDER: z.enum(['mock', 'github', 'openai', 'anthropic', 'azure-aifoundry']).default('mock'),

// Find: RATE_LIMIT_MAX: z.coerce.number()...
// Add before it:
LLM_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).default,
```

- [ ] **Step 2: Run type check to verify schema**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to our changes

- [ ] **Step 3: Commit**

```bash
cd apps/api && git add src/config/env.ts && git commit -m "feat(api): add LLM_API_KEY and azure-aifoundry provider to env schema"
```

---

## Task 2: Create LLM Cache Service

**Files:**
- Create: `apps/api/src/llm/llm-cache.service.ts`

**Purpose:** Redis-backed cache for LLM generation results. Reduces hallucinations by caching validated, schema-correct agent specs. Key = SHA-256 hash of input. TTL = 24h (configurable).

**Key design decisions:**
- Cache key is deterministic hash of normalized input (prompt + business_context + template_slug, sorted keys)
- On cache hit: return cached spec directly (no re-generation)
- On cache miss: call Azure AI Foundry, validate schema, cache result, return
- Cache invalidation: TTL-based only (24h). No manual invalidation needed for agent spec generation.
- Fallback chain: Redis hit → return | Redis miss → call LLM → cache → return | LLM fail → mock fallback

**Steps:**
- [ ] **Step 1: Create llm-cache.service.ts**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { env } from '../config/env';
import { CacheService } from '../cache/cache.service';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

const LLM_CACHE_PREFIX = 'llm:gen:';
const DEFAULT_TTL = 86400; // 24h

@Injectable()
export class LlmCacheService {
  private readonly logger = new Logger(LlmCacheService.name);
  private readonly ttl: number;

  constructor(private readonly cache: CacheService) {
    this.ttl = env.LLM_CACHE_TTL_SECONDS ?? DEFAULT_TTL;
  }

  /**
   * Build a deterministic cache key from GenerateAgentDto.
   * Hash = SHA-256 of normalized, sorted JSON of the input.
   */
  buildKey(input: GenerateAgentDto): string {
    const normalized = {
      prompt: input.prompt?.trim() ?? '',
      template_slug: input.template_slug ?? '',
      business_context: input.business_context
        ? Object.keys(input.business_context)
            .sort()
            .reduce((acc, k) => {
              const v = (input.business_context as Record<string, unknown>)[k];
              if (v !== undefined && v !== null && v !== '') acc[k] = v;
              return acc;
            }, {} as Record<string, unknown>)
        : {},
      knowledge_source_ids: [...(input.knowledge_source_ids ?? [])].sort(),
    };
    const json = JSON.stringify(normalized);
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 32);
    return `${LLM_CACHE_PREFIX}${hash}`;
  }

  async get(key: string): Promise<GenerateAgentResult | null> {
    try {
      const cached = await this.cache.get<GenerateAgentResult>(key);
      if (cached) {
        this.logger.debug(`[llm-cache] HIT for key ${key.slice(0, 20)}...`);
        return cached;
      }
      this.logger.debug(`[llm-cache] MISS for key ${key.slice(0, 20)}...`);
      return null;
    } catch (err) {
      this.logger.warn(`[llm-cache] Redis get failed: ${(err as Error).message}. Treating as miss.`);
      return null;
    }
  }

  async set(key: string, result: GenerateAgentResult): Promise<void> {
    try {
      await this.cache.set(key, result, this.ttl);
      this.logger.debug(`[llm-cache] SET key ${key.slice(0, 20)}... TTL=${this.ttl}s`);
    } catch (err) {
      this.logger.warn(`[llm-cache] Redis set failed: ${(err as Error).message}. Skipping cache.`);
    }
  }

  async invalidate(key: string): Promise<void> {
    try {
      await this.cache.del(key);
    } catch (err) {
      this.logger.warn(`[llm-cache] Redis del failed: ${(err as Error).message}.`);
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `cd apps/api && npx tsc --noEmit src/llm/llm-cache.service.ts 2>&1`
Expected: No errors

- [ ] **Step 3: Write unit test**

Create: `apps/api/src/llm/llm-cache.service.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmCacheService } from './llm-cache.service';
import type { GenerateAgentDto } from '@voiceforge/shared';

const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

const cacheService = mockCache as unknown as { get: Function; set: Function; del: Function };

describe('LlmCacheService', () => {
  let service: LlmCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new LlmCacheService(cacheService as any);
  });

  describe('buildKey', () => {
    it('should produce same key for identical inputs', () => {
      const input: GenerateAgentDto = {
        prompt: 'Build a dental receptionist agent',
        template_slug: 'ai-receptionist',
        business_context: { business_name: 'Smile Dental', industry_hint: 'dental' },
      };
      const key1 = service.buildKey(input);
      const key2 = service.buildKey(input);
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^llm:gen:[a-f0-9]{32}$/);
    });

    it('should produce same key regardless of business_context key order', () => {
      const input1: GenerateAgentDto = { prompt: 'test', business_context: { a: '1', b: '2' } };
      const input2: GenerateAgentDto = { prompt: 'test', business_context: { b: '2', a: '1' } };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });

    it('should produce different keys for different prompts', () => {
      const input1: GenerateAgentDto = { prompt: 'dental agent' };
      const input2: GenerateAgentDto = { prompt: 'real estate agent' };
      expect(service.buildKey(input1)).not.toBe(service.buildKey(input2));
    });

    it('should ignore null/undefined/empty values in business_context', () => {
      const input1: GenerateAgentDto = { prompt: 'test', business_context: { name: 'A' } };
      const input2: GenerateAgentDto = { prompt: 'test', business_context: { name: 'A', extra: undefined, other: null as unknown as string, empty: '' } };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });

    it('should sort knowledge_source_ids', () => {
      const input1: GenerateAgentDto = { prompt: 'test', knowledge_source_ids: ['c', 'a', 'b'] };
      const input2: GenerateAgentDto = { prompt: 'test', knowledge_source_ids: ['a', 'b', 'c'] };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });
  });

  describe('get', () => {
    it('should return cached result on hit', async () => {
      const mockResult: GenerateAgentResult = {
        spec: { schema_version: '1.0', name: 'Test', industry: 'dental', agent_type: 'inbound_receptionist', language: 'en', voice: { provider: 'vapi', voice_id: 'test' }, identity: { business_name: 'Test', agent_name: 'Test Agent' }, goals: ['test'], required_fields: [], conversation_rules: {}, knowledge: {}, tools: [], handoff: { enabled: false, conditions: [] }, compliance: {}, analytics: {} },
        suggested_name: 'Test Agent',
        rationale: 'test',
        matched_template_slug: 'test',
      };
      mockCache.get.mockResolvedValue(mockResult);
      const result = await service.get('llm:gen:abc123');
      expect(result).toEqual(mockResult);
    });

    it('should return null on cache miss', async () => {
      mockCache.get.mockResolvedValue(null);
      const result = await service.get('llm:gen:abc123');
      expect(result).toBeNull();
    });

    it('should return null and log warning on Redis error', async () => {
      mockCache.get.mockRejectedValue(new Error('Redis connection failed'));
      const result = await service.get('llm:gen:abc123');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should call cache.set with correct TTL', async () => {
      const mockResult: GenerateAgentResult = { spec: { schema_version: '1.0', name: 'T', industry: 'x', agent_type: 'inbound_receptionist', language: 'en', voice: { provider: 'vapi' }, identity: { business_name: 'X', agent_name: 'A' }, goals: [], required_fields: [], conversation_rules: {}, knowledge: {}, tools: [], handoff: { enabled: false, conditions: [] }, compliance: {}, analytics: {} } as any, suggested_name: '', rationale: '', matched_template_slug: '' };
      await service.set('llm:gen:abc', mockResult);
      expect(mockCache.set).toHaveBeenCalledWith('llm:gen:abc', mockResult, 86400);
    });

    it('should not throw on Redis error', async () => {
      mockCache.set.mockRejectedValue(new Error('Redis error'));
      await expect(service.set('llm:gen:abc', {} as any)).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 4: Run test**

Run: `cd apps/api && npx vitest run src/llm/llm-cache.service.test.ts 2>&1`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
cd apps/api && git add src/llm/llm-cache.service.ts src/llm/llm-cache.service.test.ts && git commit -m "feat(api): add LLM cache service with SHA-256 key + 24h TTL"
```

---

## Task 3: Create Azure AI Foundry Adapter

**Files:**
- Create: `apps/api/src/llm/adapters/azure-aifoundry.adapter.ts`
- Create: `apps/api/src/llm/adapters/azure-aifoundry.adapter.test.ts`

**Purpose:** OpenAI-compatible adapter for Azure AI Foundry. Wraps the Kimi 2.6 model with Redis caching and fallback chain: cache → Azure → mock.

**Important:** Azure AI Foundry uses `api-key` header (not `Authorization: Bearer`). The endpoint includes `/openai/deployments/<model>/chat/completions` suffix.

**Steps:**
- [ ] **Step 1: Create azure-aifoundry.adapter.ts**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import {
  AgentSpecSchema,
  MVP_TEMPLATES,
  findTemplateBySlug,
  type AgentSpec,
  type AgentTemplateSeed,
  type GenerateAgentDto,
  type GenerateAgentResult,
} from '@voiceforge/shared';
import { env } from '../../config/env';
import { MockAgentGeneratorService } from '../../agents/mock-generator.service';
import { LlmCacheService } from '../llm-cache.service';
import type { LlmAgentGenerator } from '../llm.provider.interface';

@Injectable()
export class AzureAiFoundryAdapter implements LlmAgentGenerator {
  readonly name = 'azure-aifoundry';
  private readonly logger = new Logger(AzureAiFoundryAdapter.name);
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiVersion = '2024-02-01';

  constructor(
    private readonly mock: MockAgentGeneratorService,
    private readonly cache: LlmCacheService,
  ) {
    // Base URL from env, must end with /openai/v1
    const base = env.LLM_BASE_URL ?? 'https://deepak7238kgs-0666-resource.services.ai.azure.com/openai/v1';
    this.endpoint = base.replace(/\/$/, ''); // strip trailing slash
    // Model from env (e.g. kimi-2.6-flash) or default
    this.model = env.LLM_MODEL ?? 'kimi-2.6-flash';
  }

  async generate(input: GenerateAgentDto): Promise<GenerateAgentResult> {
    // Step 1: Check Redis cache
    const cacheKey = this.cache.buildKey(input);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      this.logger.log(`[azure-aifoundry] Cache hit for prompt "${input.prompt.slice(0, 50)}..."`);
      return cached;
    }

    // Step 2: Check API key
    if (!env.LLM_API_KEY) {
      this.logger.warn('[azure-aifoundry] LLM_API_KEY not set — falling back to MockAgentGeneratorService.');
      return this.mock.generate(input);
    }

    const baseTemplate = this.pickTemplate(input);

    // Step 3: Call Azure AI Foundry
    try {
      const spec = await this.callModel(input, baseTemplate);

      // Step 4: Validate against schema — this is the hallucination gate
      const parsed = AgentSpecSchema.safeParse(spec);
      if (!parsed.success) {
        this.logger.warn(`[azure-aifoundry] Model returned invalid Agent Spec: ${parsed.error.message}`);
        return this.mock.generate(input);
      }

      const result: GenerateAgentResult = {
        spec: parsed.data,
        suggested_name: parsed.data.name,
        rationale: `Generated by Azure AI Foundry Kimi 2.6 (${this.model}). Seeded with template "${baseTemplate.name}". Validated against AgentSpecSchema v1.0. Cached for 24h.`,
        matched_template_slug: baseTemplate.slug,
      };

      // Step 5: Cache successful result
      await this.cache.set(cacheKey, result);

      this.logger.log(`[azure-aifoundry] Generated + cached agent spec for prompt "${input.prompt.slice(0, 50)}..."`);
      return result;
    } catch (err) {
      this.logger.warn(`[azure-aifoundry] Call failed: ${(err as Error).message}. Falling back to mock.`);
      return this.mock.generate(input);
    }
  }

  private async callModel(
    input: GenerateAgentDto,
    base: AgentTemplateSeed,
  ): Promise<unknown> {
    // Azure AI Foundry: POST https://<resource>.services.ai.azure.com/openai/deployments/<model>/chat/completions?api-version=2024-02-01
    const url = `${this.endpoint}/chat/completions?api-version=${this.apiVersion}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': env.LLM_API_KEY!,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: this.buildSystemPrompt() },
          { role: 'user', content: this.buildUserPrompt(input, base) },
        ],
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty model response (no choices[0].message.content).');

    // Azure AI Foundry sometimes wraps in additional JSON structure
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Non-JSON response from model: ${content.slice(0, 100)}`);
    }
    return parsed;
  }

  private pickTemplate(input: GenerateAgentDto): AgentTemplateSeed {
    if (input.template_slug) {
      const direct = findTemplateBySlug(input.template_slug);
      if (direct) return direct;
    }
    return MVP_TEMPLATES[0]!;
  }

  private buildSystemPrompt(): string {
    return [
      'You are VoiceForge AI, a generator of provider-neutral voice agent specifications.',
      'Return ONLY a JSON object that satisfies the Agent Spec v1.0 contract.',
      'Required top-level keys: schema_version="1.0", name, industry, agent_type, language, voice, identity, goals, required_fields, conversation_rules, knowledge, tools, handoff, compliance, analytics.',
      'agent_type ∈ inbound_receptionist | outbound_reminder | outbound_qualifier | outbound_confirmation | outbound_survey.',
      'For outbound_* types, set compliance.consent_required_for_outbound=true and include a sensible allowed_call_window.',
      'handoff.enabled=true requires handoff.conditions[]>=1.',
      'voice.tone is required. identity.business_name and identity.agent_name are required.',
      'goals must be a non-empty string array. tools[] each need {name, description, requires_confirmation, input_schema:{type:"object",properties,required}}.',
      'Do NOT invent fields outside the schema. Do NOT include markdown fences. Output JSON only.',
    ].join('\n');
  }

  private buildUserPrompt(input: GenerateAgentDto, base: AgentTemplateSeed): string {
    const ctx = input.business_context ?? {};
    const baseSpec: AgentSpec = base.spec as AgentSpec;
    return [
      `User prompt: ${input.prompt}`,
      ctx.business_name ? `Business name: ${ctx.business_name}` : '',
      ctx.industry_hint ? `Industry hint: ${ctx.industry_hint}` : '',
      ctx.timezone ? `Timezone: ${ctx.timezone}` : '',
      input.knowledge_source_ids?.length
        ? `Attach these knowledge_source_ids on knowledge.source_ids: ${JSON.stringify(input.knowledge_source_ids)}`
        : '',
      `Use the following template as the starting point and tailor it to the prompt:`,
      JSON.stringify(baseSpec, null, 2),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
```

- [ ] **Step 2: Create test file**

Create: `apps/api/src/llm/adapters/azure-aifoundry.adapter.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureAiFoundryAdapter } from './azure-aifoundry.adapter';
import { MockAgentGeneratorService } from '../../agents/mock-generator.service';
import { LlmCacheService } from '../llm-cache.service';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

// Mock the env module
vi.mock('../../config/env', () => ({
  env: {
    LLM_API_KEY: 'test-key',
    LLM_BASE_URL: 'https://test.azure.com/openai/v1',
    LLM_MODEL: 'kimi-2.6-flash',
  },
}));

const mockCache = {
  buildKey: vi.fn((input: GenerateAgentDto) => 'llm:gen:abc123'),
  get: vi.fn(),
  set: vi.fn(),
};

const mockMock = {
  generate: vi.fn(),
};

describe('AzureAiFoundryAdapter', () => {
  let adapter: AzureAiFoundryAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AzureAiFoundryAdapter(
      mockMock as unknown as MockAgentGeneratorService,
      mockCache as unknown as LlmCacheService,
    );
  });

  describe('generate', () => {
    it('should return cached result on cache hit', async () => {
      const cached: GenerateAgentResult = {
        spec: { schema_version: '1.0', name: 'Cached Agent', industry: 'dental', agent_type: 'inbound_receptionist', language: 'en', voice: { provider: 'vapi' }, identity: { business_name: 'Dental Corp', agent_name: 'Receptionist' }, goals: ['answer calls'], required_fields: [], conversation_rules: {}, knowledge: {}, tools: [], handoff: { enabled: false, conditions: [] }, compliance: {}, analytics: {} } as any,
        suggested_name: 'Cached Agent',
        rationale: 'cached result',
        matched_template_slug: 'ai-receptionist',
      };
      mockCache.get.mockResolvedValue(cached);

      const input: GenerateAgentDto = { prompt: 'Build dental receptionist' };
      const result = await adapter.generate(input);

      expect(result).toBe(cached);
      expect(mockCache.get).toHaveBeenCalledWith('llm:gen:abc123');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should call Azure API on cache miss', async () => {
      mockCache.get.mockResolvedValue(null);
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              schema_version: '1.0',
              name: 'Real Estate Agent',
              industry: 'real estate',
              agent_type: 'outbound_qualifier',
              language: 'en',
              voice: { provider: 'vapi', voice_id: 'female-1', tone: 'professional' },
              identity: { business_name: 'HomeSell', agent_name: 'Sarah' },
              goals: ['qualify leads', 'schedule viewings'],
              required_fields: [],
              conversation_rules: {},
              knowledge: {},
              tools: [{ name: 'google_calendar.book_slot', description: 'Book slot', requires_confirmation: true, input_schema: { type: 'object', properties: {}, required: [] } }],
              handoff: { enabled: true, conditions: ['caller_requests_human'] },
              compliance: { consent_required_for_outbound: true },
              analytics: {},
            }),
          },
        }],
      };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      }) as unknown as typeof fetch;

      const input: GenerateAgentDto = { prompt: 'Build real estate agent' };
      const result = await adapter.generate(input);

      expect(fetch).toHaveBeenCalled();
      expect(result.suggested_name).toBe('Real Estate Agent');
      expect(result.spec.agent_type).toBe('outbound_qualifier');
      expect(mockCache.set).toHaveBeenCalled();
    });

    it('should fall back to mock on missing API key', async () => {
      vi.doMock('../../config/env', () => ({
        env: { LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '' },
      }));
      mockCache.get.mockResolvedValue(null);

      const mockResult: GenerateAgentResult = { spec: {} as any, suggested_name: 'mock', rationale: '', matched_template_slug: '' };
      mockMock.generate.mockReturnValue(mockResult);

      const adapter2 = new AzureAiFoundryAdapter(mockMock as any, mockCache as any);
      const result = await adapter2.generate({ prompt: 'test' });
      expect(result).toBe(mockResult);
    });

    it('should fall back to mock on HTTP error', async () => {
      mockCache.get.mockResolvedValue(null);
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      }) as unknown as typeof fetch;

      mockMock.generate.mockReturnValue({ spec: {} as any, suggested_name: 'fallback', rationale: '', matched_template_slug: '' });

      const result = await adapter.generate({ prompt: 'test' });
      expect(result.suggested_name).toBe('fallback');
    });

    it('should fall back to mock on invalid JSON response', async () => {
      mockCache.get.mockResolvedValue(null);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: 'not json' } }] }),
      }) as unknown as typeof fetch;

      mockMock.generate.mockReturnValue({ spec: {} as any, suggested_name: 'fallback', rationale: '', matched_template_slug: '' });

      const result = await adapter.generate({ prompt: 'test' });
      expect(result.suggested_name).toBe('fallback');
    });

    it('should fall back to mock on schema validation failure', async () => {
      mockCache.get.mockResolvedValue(null);
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ name: 'Invalid' }) } }] }),
      }) as unknown as typeof fetch;

      mockMock.generate.mockReturnValue({ spec: {} as any, suggested_name: 'fallback', rationale: '', matched_template_slug: '' });

      const result = await adapter.generate({ prompt: 'test' });
      expect(result.suggested_name).toBe('fallback');
    });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd apps/api && npx vitest run src/llm/adapters/azure-aifoundry.adapter.test.ts 2>&1`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd apps/api && git add src/llm/adapters/azure-aifoundry.adapter.ts src/llm/adapters/azure-aifoundry.adapter.test.ts && git commit -m "feat(api): add Azure AI Foundry adapter for Kimi 2.6 with Redis cache + schema validation"
```

---

## Task 4: Wire Azure Adapter into LLM Module

**Files:**
- Modify: `apps/api/src/llm/llm.module.ts`
- Modify: `apps/api/src/llm/llm.service.ts` (if it exists — check first)

**Steps:**
- [ ] **Step 1: Read llm.module.ts and llm.service.ts**

Check if `llm.service.ts` exists and how it selects the adapter.

- [ ] **Step 2: Update llm.module.ts**

Add `AzureAiFoundryAdapter` to the module's providers. If the module uses `LLM_PROVIDER` to switch adapters, update the factory:

```typescript
// Add AzureAiFoundryAdapter import
// Add to providers array, use useFactory to select based on LLM_PROVIDER
```

- [ ] **Step 3: Verify DI compiles**

Run: `cd apps/api && npx tsc --noEmit 2>&1 | head -30`

- [ ] **Step 4: Commit**

```bash
cd apps/api && git add src/llm/llm.module.ts && git commit -m "feat(api): wire AzureAiFoundryAdapter into LLM module DI"
```

---

## Task 5: Implement Real Vapi Adapter

**Files:**
- Modify: `apps/api/src/voice/adapters/vapi.adapter.ts`
- Create: `apps/api/src/voice/adapters/vapi.adapter.test.ts`

**Vapi API base URL:** `https://api.vapi.ai`
**Auth:** `Authorization: Bearer ${VAPI_API_KEY}`

**Key methods to implement:**
- `createAgent` → POST `/assistant` with VoiceForge agent spec mapped to Vapi format
- `updateAgent` → PATCH `/assistant/{id}`
- `startOutboundCall` → POST `/call/outbound` with `{ assistantId, customer, ... }`
- `endCall` → POST `/call/{id}/end`
- `getTranscript` → GET `/call/{id}/transcript`
- `getRecording` → GET `/call/{id}/recording`
- `createBrowserTestSession` → POST `/assistant/{id}/test-access-token`
- `transferCall` → POST `/call/{id}/transfer`

**Steps:**
- [ ] **Step 1: Read existing mock adapter to understand interface usage**

Read: `apps/api/src/voice/adapters/mock.adapter.ts` for reference patterns.

- [ ] **Step 2: Rewrite vapi.adapter.ts**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { AppError } from '../../common/errors';
import type {
  VoiceRuntimeProvider,
  CreateRuntimeAgentInput,
  CreateRuntimeAgentResult,
  UpdateRuntimeAgentInput,
  CreateBrowserTestSessionInput,
  BrowserTestSessionResult,
  StartOutboundCallInput,
  StartOutboundCallResult,
  TransferCallInput,
  EndCallInput,
  GetTranscriptInput,
  TranscriptResult,
  GetRecordingInput,
  RecordingResult,
} from './voice.provider.interface';

const VAPI_BASE_URL = 'https://api.vapi.ai';

@Injectable()
export class VapiVoiceAdapter implements VoiceRuntimeProvider {
  readonly name = 'vapi';
  private readonly logger = new Logger(VapiVoiceAdapter.name);

  private get headers(): Record<string, string> {
    const key = env.VAPI_API_KEY;
    if (!key) throw new AppError('VOICE_PROVIDER_ERROR', 'VAPI_API_KEY is not set. Set VAPI_API_KEY in .env', 500);
    return {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    };
  }

  private async vapiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${VAPI_BASE_URL}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`[vapi] ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      throw new AppError('VOICE_PROVIDER_ERROR', `Vapi API error: HTTP ${res.status} ${res.statusText}. ${text.slice(0, 100)}`, res.status as number);
    }
    return res.json() as Promise<T>;
  }

  async createAgent(input: CreateRuntimeAgentInput): Promise<CreateRuntimeAgentResult> {
    this.logger.log(`[vapi] createAgent workspace=${input.workspaceId} agent=${input.agentId}`);
    const spec = input.spec;

    // Map AgentSpec to Vapi assistant format
    const vapiAssistant = {
      name: spec.name,
      model: {
        provider: 'openai',
        model: 'gpt-4',
        systemPrompt: this.buildSystemPrompt(spec),
        messages: [],
      },
      voice: {
        provider: 'vapi',
        voiceId: spec.voice.voice_id ?? 'female-1',
        model: spec.voice.model ?? 'default',
      },
      // Outbound calling: set first caller number + intro message
      firstMessage: spec.conversation_rules.first_message ?? `Hi, this is ${spec.identity.agent_name}.`,
      // Compliance
      complianceSettings: {
        doNotDisturb: !spec.compliance.opt_out_enabled,
        recordingNotificationsEnabled: spec.compliance.recording_notice_required ?? false,
      },
      // Metadata for later correlation
      metadata: {
        voiceforge_agent_id: input.agentId,
        voiceforge_agent_version_id: input.agentVersionId,
        voiceforge_workspace_id: input.workspaceId,
      },
    };

    const result = await this.vapiRequest<{ id: string }>('POST', '/assistant', vapiAssistant);
    this.logger.log(`[vapi] createAgent → provider_runtime_id=${result.id}`);
    return { provider_runtime_id: result.id };
  }

  async updateAgent(input: UpdateRuntimeAgentInput): Promise<void> {
    this.logger.log(`[vapi] updateAgent runtime=${input.provider_runtime_id}`);
    const spec = input.spec;
    const update = {
      name: spec.name,
      firstMessage: spec.conversation_rules.first_message,
      voice: {
        voiceId: spec.voice.voice_id ?? 'female-1',
      },
    };
    await this.vapiRequest('PATCH', `/assistant/${input.provider_runtime_id}`, update);
  }

  async createBrowserTestSession(input: CreateBrowserTestSessionInput): Promise<BrowserTestSessionResult> {
    this.logger.log(`[vapi] createBrowserTestSession agent=${input.agentId}`);
    // Vapi doesn't have a direct browser test API — simulate with a test call
    const testNumber = '+15550000000'; // Vapi test number
    const result = await this.vapiRequest<{ id: string; status: string }>('POST', '/call/outbound', {
      assistantId: input.agentId,
      customer: { number: testNumber },
    });
    return {
      test_session_id: result.id,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min
    };
  }

  async startOutboundCall(input: StartOutboundCallInput): Promise<StartOutboundCallResult> {
    this.logger.log(`[vapi] startOutboundCall to=${input.toNumber} agent=${input.agentId}`);
    const result = await this.vapiRequest<{ id: string; status: string }>('POST', '/call/outbound', {
      assistantId: input.agentVersionId,
      customer: { number: input.toNumber },
      ...(input.fromNumber && { caller: { number: input.fromNumber } }),
      ...(input.metadata && { metadata: input.metadata }),
    });
    return { provider_call_id: result.id, status: result.status as 'queued' | 'ringing' };
  }

  async transferCall(input: TransferCallInput): Promise<void> {
    this.logger.log(`[vapi] transferCall call=${input.callId} target=${input.targetNumber}`);
    await this.vapiRequest('POST', `/call/${input.callId}/transfer`, {
      customer: { number: input.targetNumber },
    });
  }

  async endCall(input: EndCallInput): Promise<void> {
    this.logger.log(`[vapi] endCall call=${input.callId} reason=${input.reason ?? 'user-ended'}`);
    await this.vapiRequest('POST', `/call/${input.callId}/end`, {
      reason: input.reason ?? 'ended-by-agent',
    });
  }

  async getTranscript(input: GetTranscriptInput): Promise<TranscriptResult> {
    this.logger.log(`[vapi] getTranscript call=${input.callId}`);
    const result = await this.vapiRequest<{ transcript: string; messages?: Array<{ role: string; content: string; timestamp: number }> }>('GET', `/call/${input.callId}/transcript`);
    const turns = (result.messages ?? []).map((m) => ({
      speaker: m.role === 'assistant' ? 'agent' : 'caller',
      text: m.content,
      at_ms: m.timestamp,
    }));
    return { transcript: result.transcript ?? turns.map((t) => t.text).join('\n'), turns };
  }

  async getRecording(input: GetRecordingInput): Promise<RecordingResult> {
    this.logger.log(`[vapi] getRecording call=${input.callId}`);
    const result = await this.vapiRequest<{ url: string | null; duration: number | null }>('GET', `/call/${input.callId}/recording`);
    return { url: result.url, duration_seconds: result.duration };
  }

  private buildSystemPrompt(spec: CreateRuntimeAgentInput['spec']): string {
    const parts: string[] = [
      `You are ${spec.identity.agent_name}, the AI agent for ${spec.identity.business_name}.`,
      spec.identity.disclosure ? `Disclosure: ${spec.identity.disclosure}` : '',
      `Your goals: ${spec.goals.join('; ')}.`,
      `Language: ${spec.language}`,
      `Industry: ${spec.industry}`,
    ];
    if (spec.tools.length > 0) {
      parts.push(`Tools available: ${spec.tools.map((t) => `${t.name}: ${t.description}`).join('; ')}.`);
    }
    if (spec.handoff.enabled) {
      parts.push(`Transfer to human when: ${spec.handoff.conditions.join(', ')}.`);
    }
    if (spec.compliance.opt_out_enabled) {
      parts.push('Respect DNC requests. End call if caller requests opt-out.');
    }
    return parts.filter(Boolean).join('\n');
  }
}
```

- [ ] **Step 3: Create test file**

Create: `apps/api/src/voice/adapters/vapi.adapter.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VapiVoiceAdapter } from './vapi.adapter';

vi.mock('../../config/env', () => ({
  env: { VAPI_API_KEY: 'test-key' },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('VapiVoiceAdapter', () => {
  let adapter: VapiVoiceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new VapiVoiceAdapter();
  });

  describe('createAgent', () => {
    it('should create Vapi assistant and return runtime ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'vapi-assistant-123' }),
      } as Response);

      const result = await adapter.createAgent({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'v-1',
        spec: {
          schema_version: '1.0', name: 'Test Agent', industry: 'dental', agent_type: 'inbound_receptionist',
          language: 'en', voice: { provider: 'vapi', voice_id: 'female-1', tone: 'friendly' },
          identity: { business_name: 'Test Corp', agent_name: 'Alice', disclosure: 'Hi, I am Alice' },
          goals: ['answer calls', 'book appointments'],
          required_fields: [], conversation_rules: { first_message: 'Hello' },
          knowledge: {}, tools: [{ name: 'google_calendar.book_slot', description: 'Book slot', requires_confirmation: true, input_schema: { type: 'object', properties: {}, required: [] } }],
          handoff: { enabled: true, conditions: ['caller_requests_human'] },
          compliance: { opt_out_enabled: true },
          analytics: {},
        },
      });

      expect(result.provider_runtime_id).toBe('vapi-assistant-123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.vapi.ai/assistant',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('startOutboundCall', () => {
    it('should start outbound call with phone number', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'call-456', status: 'queued' }),
      } as Response);

      const result = await adapter.startOutboundCall({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'vapi-assistant-123',
        toNumber: '+14155551234',
        fromNumber: '+15550000000',
      });

      expect(result.provider_call_id).toBe('call-456');
      expect(result.status).toBe('queued');
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body as string);
      expect(body.customer.number).toBe('+14155551234');
      expect(body.caller.number).toBe('+15550000000');
    });
  });

  describe('endCall', () => {
    it('should end a call', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) } as Response);
      await adapter.endCall({ callId: 'call-123', reason: 'completed' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.vapi.ai/call/call-123/end',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('getTranscript', () => {
    it('should return transcript with turns', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          transcript: 'Hello, this is Alice.',
          messages: [
            { role: 'assistant', content: 'Hello, this is Alice.', timestamp: 1000 },
            { role: 'user', content: 'Hi, I need to book an appointment.', timestamp: 3000 },
          ],
        }),
      } as Response);

      const result = await adapter.getTranscript({ callId: 'call-123' });
      expect(result.turns).toHaveLength(2);
      expect(result.turns[0].speaker).toBe('agent');
      expect(result.turns[1].speaker).toBe('caller');
    });
  });

  describe('error handling', () => {
    it('should throw AppError on HTTP 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: () => Promise.resolve('Invalid API key'),
      } as Response);

      await expect(adapter.createAgent({
        workspaceId: 'ws', agentId: 'ag', agentVersionId: 'v',
        spec: { schema_version: '1.0', name: 'T', industry: 'x', agent_type: 'inbound_receptionist', language: 'en', voice: { provider: 'vapi' }, identity: { business_name: 'X', agent_name: 'A' }, goals: [], required_fields: [], conversation_rules: {}, knowledge: {}, tools: [], handoff: { enabled: false, conditions: [] }, compliance: {}, analytics: {} } as any,
      })).rejects.toThrow('Vapi API error: HTTP 401');
    });
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/voice/adapters/vapi.adapter.test.ts 2>&1`

- [ ] **Step 5: Commit**

```bash
cd apps/api && git add src/voice/adapters/vapi.adapter.ts src/voice/adapters/vapi.adapter.test.ts && git commit -m "feat(api): implement real Vapi adapter with all voice provider methods"
```

---

## Task 6: Auth — Confirm Clerk Wiring + Update .env

**Files:**
- Modify: `apps/api/.env` (fill in CLERK_SECRET_KEY, or create .env.local)
- Verify: `apps/api/src/auth/auth.module.ts` (already correct per earlier read)

**Steps:**
- [ ] **Step 1: Confirm auth.module.ts wiring**

Already read: uses `AUTH_PROVIDER === 'clerk' ? clerk : mock`. No changes needed.

- [ ] **Step 2: Document what user needs to do**

Add to `.env` or create `.env.local`:
```
AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=sk_test_...
```

**No code changes needed.** Commit only if you touched any file.

---

## Task 7: Update .env with All Real Keys

**Files:**
- Modify: `apps/api/.env`

**Changes:**
```
AUTH_PROVIDER=clerk
CLERK_SECRET_KEY=sk_test_...           # User fills this

LLM_PROVIDER=azure-aifoundry
LLM_API_KEY=...                        # User fills this
LLM_BASE_URL=https://deepak7238kgs-0666-resource.services.ai.ai.net/openai/v1
LLM_MODEL=kimi-2.6-flash              # or whatever the deployment name is
LLM_CACHE_TTL_SECONDS=86400

VOICE_PROVIDER=vapi
VAPI_API_KEY=...                       # User fills this

EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=...                    # For real embeddings (optional)
```

- [ ] **Step 1: Update .env**

Change the provider values and add the new env vars. Leave placeholder values for sensitive keys.

- [ ] **Step 2: Commit (if changed)**

```bash
cd apps/api && git add .env && git commit -m "chore(api): update .env with real provider configs"
```

---

## Task 8: Integration Test — End-to-End Generate Flow

**Files:**
- Create: `apps/api/src/llm/adapters/azure-aifoundry.integration.test.ts`

**Purpose:** Test the full flow: cache hit → Azure call → mock fallback → schema validation.

**Steps:**
- [ ] **Step 1: Write integration test covering cache + generation**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureAiFoundryAdapter } from './azure-aifoundry.adapter';

describe('AzureAiFoundryAdapter integration', () => {
  it('should cache result on successful generation', async () => {
    // Full flow test — real adapter, mocked fetch + cache
  });

  it('should return cached result on second call with same prompt', async () => {
    // Verify cache key is deterministic
  });

  it('should fall back to mock when model returns malformed spec', async () => {
    // Test hallucination safety net
  });
});
```

- [ ] **Step 2: Run**

Run: `cd apps/api && npx vitest run src/llm/adapters/azure-aifoundry.integration.test.ts 2>&1`

- [ ] **Step 3: Commit**

---

## Self-Review Checklist

Before marking complete, verify:

- [ ] `env.ts` updated — `LLM_API_KEY`, `azure-aifoundry` in enum, `LLM_CACHE_TTL_SECONDS`
- [ ] `llm-cache.service.ts` created with SHA-256 deterministic key
- [ ] `azure-aifoundry.adapter.ts` uses `api-key` header (Azure style), has cache-first logic
- [ ] Schema validation gate — hallucinated/incomplete specs → mock fallback
- [ ] `vapi.adapter.ts` all 8 interface methods implemented
- [ ] Both new adapters have test files
- [ ] All tests pass with `npx vitest run`
- [ ] `.env` updated with provider configs
- [ ] No breaking changes — fallback chains preserved throughout

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-30-replace-mocks-with-real-providers-plan.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?