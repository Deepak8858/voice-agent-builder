import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be top-level so vitest hoists the mock before any imports.
// Only this file mocks the env module, so there is no ambiguity.
vi.mock('../../config/env', () => ({
  env: {
    LLM_API_KEY: 'mock-api-key-for-tests',
    LLM_BASE_URL: 'https://example.openai.azure.com/openai/v1',
    LLM_MODEL: 'kimi-2.6-flash',
    LLM_API_VERSION: undefined,
    NODE_ENV: 'test',
  },
}));

import { AzureAiFoundryAdapter } from './azure-aifoundry.adapter';
import { LlmCacheService } from '../llm-cache.service';
import { MockAgentGeneratorService } from '../../agents/mock-generator.service';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

function makeValidSpec(overrides: Partial<import('@voiceforge/shared').AgentSpec> = {}) {
  return {
    schema_version: '1.0' as const,
    name: 'Test Agent',
    industry: 'healthcare',
    agent_type: 'inbound_receptionist' as const,
    language: 'en',
    voice: { tone: 'professional' },
    identity: { business_name: 'Test Corp', agent_name: 'Alice' },
    goals: ['Greet caller', 'Collect info'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
    tools: [],
    handoff: { enabled: false, conditions: [] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
    ...overrides,
  };
}

const BASE_DTO: GenerateAgentDto = {
  prompt: 'Create a receptionist for a dental clinic',
  template_slug: undefined,
  business_context: undefined,
  knowledge_source_ids: [],
};

describe('AzureAiFoundryAdapter', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockCache: Record<string, unknown>;
  let mockCacheService: LlmCacheService;
  let mockGen: MockAgentGeneratorService;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockCache = {};

    mockCacheService = new LlmCacheService({
      async get<T>(_key: string): Promise<T | null> {
        return null;
      },
      async set(key: string, value: unknown, _ttl?: number): Promise<void> {
        mockCache[key] = value;
      },
      async del(_key: string): Promise<void> {},
    } as import('../../cache/cache.service').CacheService);

    mockGen = new MockAgentGeneratorService();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // Test 1: Cache hit — returns cached result without calling fetch
  // -------------------------------------------------------------------------
  it('returns cached result without calling Azure API', async () => {
    const cachedResult: GenerateAgentResult = {
      spec: makeValidSpec({ name: 'Cached Agent' }),
      suggested_name: 'Cached Agent',
      rationale: 'Cached result',
      matched_template_slug: 'appointment-reminder',
    };

    const cacheServiceWithHit = new LlmCacheService({
      async get<T>(_key: string): Promise<T | null> {
        return cachedResult as T;
      },
      async set(_key: string, _value: unknown, _ttl?: number): Promise<void> {},
      async del(_key: string): Promise<void> {},
    } as import('../../cache/cache.service').CacheService);

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const adapter = new AzureAiFoundryAdapter(mockGen, cacheServiceWithHit);
    const result = await adapter.generate(BASE_DTO);

    expect(result.suggested_name).toBe('Cached Agent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Cache miss + successful Azure response — calls API, caches result
  // -------------------------------------------------------------------------
  it('calls Azure API on cache miss and caches the result', async () => {
    const validSpec = makeValidSpec({ name: 'Azure Agent' });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validSpec) } }],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const adapter = new AzureAiFoundryAdapter(mockGen, mockCacheService);
    const result = await adapter.generate(BASE_DTO);

    // The adapter called Azure (not mock) — result is from API
    expect(result.suggested_name).toBe('Azure Agent');
    expect(result.rationale).toContain('Azure AI Foundry Kimi 2.6');

    // API was called (the mock picks `ai-receptionist` for this prompt)
    expect(fetchMock).toHaveBeenCalled();
    expect(result.matched_template_slug).toBe('ai-receptionist');

    // Result was cached
    const cacheKey = mockCacheService.buildKey(BASE_DTO);
    expect(mockCache[cacheKey]).toBeDefined();
    expect((mockCache[cacheKey] as GenerateAgentResult).suggested_name).toBe('Azure Agent');
  });

  // -------------------------------------------------------------------------
  // Test 3: HTTP 401 error — falls back to mock
  // -------------------------------------------------------------------------
  it('falls back to mock on HTTP 401 (auth error)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const adapter = new AzureAiFoundryAdapter(mockGen, mockCacheService);
    const result = await adapter.generate(BASE_DTO);

    expect(result.matched_template_slug).toBe('dental-receptionist');
    expect(result.rationale).toContain('Matched template');
  });

  // -------------------------------------------------------------------------
  // Test 4: Invalid JSON response — falls back to mock
  // -------------------------------------------------------------------------
  it('falls back to mock when model returns non-JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'This is not JSON at all' } }],
      }), { status: 200 }),
    );

    const adapter = new AzureAiFoundryAdapter(mockGen, mockCacheService);
    const result = await adapter.generate(BASE_DTO);

    expect(result.matched_template_slug).toBe('dental-receptionist');
    expect(result.rationale).toContain('Matched template');
  });

  // -------------------------------------------------------------------------
  // Test 5: Valid JSON but invalid schema — falls back to mock
  // -------------------------------------------------------------------------
  it('falls back to mock when model returns valid JSON but invalid AgentSpec', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ foo: 'bar' }) } }],
      }), { status: 200 }),
    );

    const adapter = new AzureAiFoundryAdapter(mockGen, mockCacheService);
    const result = await adapter.generate(BASE_DTO);

    expect(result.matched_template_slug).toBe('dental-receptionist');
    expect(result.rationale).toContain('Matched template');
  });
});
