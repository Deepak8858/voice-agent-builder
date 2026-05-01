/**
 * Integration tests for the AzureAiFoundryAdapter.
 *
 * Tests the full flow:
 *   1. Cache miss + API call -> result returned, cache written
 *   2. Cache hit -> cached result returned, no API call
 *   3. Missing API key -> throws
 *   4. HTTP error -> throws
 *   5. Invalid schema -> throws
 *
 * Uses dynamic imports with vi.doMock to avoid module-cache pollution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GenerateAgentDto, GenerateAgentResult, AgentSpec } from '@voiceforge/shared';

const inMemoryCacheStore = new Map<string, unknown>();

function makeValidSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
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

async function buildAdapter(opts: {
  apiKey: string;
  customGet?: (key: string) => Promise<GenerateAgentResult | null>;
}) {
  vi.resetModules();

  vi.doMock('../../cache/cache.service', () => ({
    CacheService: {
      prototype: {},
    },
  }));

  vi.doMock('../../config/env', () => ({
    env: {
      LLM_API_KEY: opts.apiKey,
      LLM_BASE_URL: 'https://example.openai.azure.com/openai/v1',
      LLM_MODEL: 'kimi-2.6-flash',
      LLM_API_VERSION: '2024-02-01',
      NODE_ENV: 'test',
    },
  }));

  const { AzureAiFoundryAdapter } = await import('./azure-aifoundry.adapter');
  const { LlmCacheService } = await import('../llm-cache.service');
  const { CacheService } = await import('../../cache/cache.service');

  inMemoryCacheStore.clear();

  const cacheService = new LlmCacheService({
    async get<T>(key: string): Promise<T | null> {
      if (opts.customGet) return opts.customGet(key) as Promise<T | null>;
      return (inMemoryCacheStore.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown, _ttl?: number): Promise<void> {
      inMemoryCacheStore.set(key, value);
    },
    async del(key: string): Promise<void> {
      inMemoryCacheStore.delete(key);
    },
  } as unknown as CacheService);

  return { adapter: new AzureAiFoundryAdapter(cacheService), cacheService };
}

describe('AzureAiFoundryAdapter (integration)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    inMemoryCacheStore.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('on cache miss attempts the Azure API (fetch called)', async () => {
    const validSpec = makeValidSpec({ name: 'Azure Agent' });

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(validSpec) } }],
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const { adapter, cacheService } = await buildAdapter({ apiKey: 'mock-api-key-for-tests' });
    const result = await adapter.generate(BASE_DTO);

    expect(result.suggested_name).toBe('Azure Agent');
    expect(result.rationale).toContain('Azure AI Foundry Kimi 2.6');
    expect(fetchMock).toHaveBeenCalled();

    const cacheKey = cacheService.buildKey(BASE_DTO);
    const cached = await cacheService.get(cacheKey);
    expect(cached).not.toBeNull();
    expect(cached!.suggested_name).toBe('Azure Agent');
  });

  it('returns cached result without calling Azure API', async () => {
    const cachedResult: GenerateAgentResult = {
      spec: makeValidSpec({ name: 'Cached Agent' }),
      suggested_name: 'Cached Agent',
      rationale: 'Cached result',
      matched_template_slug: 'appointment-reminder',
    };

    const { adapter } = await buildAdapter({
      apiKey: 'mock-api-key-for-tests',
      customGet: () => Promise.resolve(cachedResult),
    });

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const result = await adapter.generate(BASE_DTO);

    expect(result.suggested_name).toBe('Cached Agent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    const { adapter } = await buildAdapter({ apiKey: 'mock-api-key-for-tests' });
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('Unauthorized');
  });

  it('throws when model returns valid JSON but invalid AgentSpec', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ foo: 'bar' }) } }],
      }), { status: 200 }),
    );

    const { adapter } = await buildAdapter({ apiKey: 'mock-api-key-for-tests' });
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('invalid Agent Spec');
  });
});

describe('AzureAiFoundryAdapter (missing API key)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    inMemoryCacheStore.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('throws when LLM_API_KEY is not set', async () => {
    vi.resetModules();

    vi.doMock('../../cache/cache.service', () => ({
      CacheService: {
        prototype: {},
      },
    }));

    vi.doMock('../../config/env', () => ({
      env: {
        LLM_API_KEY: '',
        LLM_BASE_URL: 'https://example.openai.azure.com/openai/v1',
        LLM_MODEL: 'kimi-2.6-flash',
        LLM_API_VERSION: '2024-02-01',
        NODE_ENV: 'test',
      },
    }));

    const { AzureAiFoundryAdapter } = await import('./azure-aifoundry.adapter');
    const { LlmCacheService } = await import('../llm-cache.service');
    const { CacheService } = await import('../../cache/cache.service');

    const innerCache = new Map<string, unknown>();
    const cacheService = new LlmCacheService({
      async get<T>(key: string): Promise<T | null> {
        return (innerCache.get(key) as T) ?? null;
      },
      async set(key: string, value: unknown, _ttl?: number): Promise<void> {
        innerCache.set(key, value);
      },
      async del(key: string): Promise<void> {
        innerCache.delete(key);
      },
    } as unknown as CacheService);

    const adapter = new AzureAiFoundryAdapter(cacheService);

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('LLM_API_KEY not set');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
