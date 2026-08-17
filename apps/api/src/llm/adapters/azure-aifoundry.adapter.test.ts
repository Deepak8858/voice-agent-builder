import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must be top-level so vitest hoists the mock before any imports.
// Only this file mocks the env module, so there is no ambiguity.
const mockEnv = vi.hoisted(
  (): {
    LLM_API_KEY: string;
    LLM_BASE_URL: string | undefined;
    LLM_MODEL: string;
    LLM_API_VERSION: string | undefined;
    NODE_ENV: string;
  } => ({
    LLM_API_KEY: 'mock-api-key-for-tests',
    LLM_BASE_URL: 'https://example.openai.azure.com/openai/v1',
    LLM_MODEL: 'kimi-2.6-flash',
    LLM_API_VERSION: undefined,
    NODE_ENV: 'test',
  }),
);

vi.mock('../../config/env', () => ({
  env: mockEnv,
}));

import { AzureAiFoundryAdapter } from './azure-aifoundry.adapter';
import { LlmCacheService } from '../llm-cache.service';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

function makeValidSpec(
  overrides: Partial<import('@voiceforge/shared').AgentSpec> = {},
): import('@voiceforge/shared').AgentSpec {
  return {
    schema_version: '1.0' as const,
    name: 'Test Agent',
    industry: 'healthcare',
    agent_type: 'inbound_receptionist' as const,
    language: 'en',
    voice: { tone: 'professional', allow_interruptions: true },
    identity: { business_name: 'Test Corp', agent_name: 'Alice' },
    goals: ['Greet caller', 'Collect info'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: {
      retrieval_mode: 'agent_scoped' as const,
      max_chunks: 5,
      source_ids: [] as string[],
    },
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

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockEnv.LLM_BASE_URL = 'https://example.openai.azure.com/openai/v1';
    mockEnv.LLM_MODEL = 'kimi-2.6-flash';
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('requires an explicit Azure AI Foundry endpoint', async () => {
    mockEnv.LLM_BASE_URL = undefined;

    // The adapter is constructed eagerly by DI even when another provider is
    // selected, so the missing-endpoint error is raised on first use instead
    // of in the constructor (the LLM module factory also fails fast at boot).
    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await expect(
      adapter.chatGenerate({
        messages: [{ role: 'user', content: 'Build an agent', at: new Date().toISOString() }],
      }),
    ).rejects.toThrow('LLM_BASE_URL is required');
  });

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

    const adapter = new AzureAiFoundryAdapter(cacheServiceWithHit);
    const result = await adapter.generate(BASE_DTO);

    expect(result.suggested_name).toBe('Cached Agent');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls Azure API on cache miss and caches the result', async () => {
    const validSpec = makeValidSpec({ name: 'Azure Agent' });

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(validSpec) } }],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock;

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    const result = await adapter.generate(BASE_DTO);

    expect(result.suggested_name).toBe('Azure Agent');
    expect(result.rationale).toContain('Generated by Azure AI Foundry');
    expect(fetchMock).toHaveBeenCalled();
    expect(result.matched_template_slug).toBe('ai-receptionist');

    const cacheKey = mockCacheService.buildKey(BASE_DTO);
    expect(mockCache[cacheKey]).toBeDefined();
    expect((mockCache[cacheKey] as GenerateAgentResult).suggested_name).toBe('Azure Agent');
  });

  it('omits temperature for GPT-5 models', async () => {
    mockEnv.LLM_MODEL = 'gpt-5.4-mini';
    const response = {
      assistant_message: 'Created the GPT-5 agent.',
      spec: makeValidSpec({ name: 'GPT-5 Agent' }),
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock;

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await adapter.chatGenerate({
      messages: [{ role: 'user', content: 'Build an agent', at: new Date().toISOString() }],
    });

    const request = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(String(request.body))).not.toHaveProperty('temperature');
  });

  it('throws on HTTP 401 (auth error)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('Unauthorized');
  });

  it('throws when model returns non-JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'This is not JSON at all' } }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow();
  });

  it('throws when model returns valid JSON but invalid AgentSpec', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ foo: 'bar' }) } }],
        }),
        { status: 200 },
      ),
    );

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('invalid Agent Spec');
  });
});
