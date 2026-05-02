import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Separate mock for the no-API-key scenario — this file gets its own hoisted mock
// so there is no module-cache pollution between test files.
vi.mock('../../config/env', () => ({
  env: {
    LLM_API_KEY: '',
    LLM_BASE_URL: 'https://example.openai.azure.com/openai/v1',
    LLM_MODEL: 'kimi-2.6-flash',
    LLM_API_VERSION: undefined,
    NODE_ENV: 'test',
  },
}));

import { AzureAiFoundryAdapter } from './azure-aifoundry.adapter';
import { LlmCacheService } from '../llm-cache.service';
import type { GenerateAgentDto } from '@voiceforge/shared';

const BASE_DTO: GenerateAgentDto = {
  prompt: 'Create a receptionist for a dental clinic',
  template_slug: undefined,
  business_context: undefined,
  knowledge_source_ids: [],
};

describe('AzureAiFoundryAdapter (no API key)', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockCacheService: LlmCacheService;

  beforeEach(() => {
    originalFetch = globalThis.fetch;

    mockCacheService = new LlmCacheService({
      async get<T>(_key: string): Promise<T | null> {
        return null;
      },
      async set(_key: string, _value: unknown, _ttl?: number): Promise<void> {},
      async del(_key: string): Promise<void> {},
    } as import('../../cache/cache.service').CacheService);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when LLM_API_KEY is not set', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as never;

    const adapter = new AzureAiFoundryAdapter(mockCacheService);
    await expect(adapter.generate(BASE_DTO)).rejects.toThrow('LLM_API_KEY not set');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
