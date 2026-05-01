import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmCacheService } from './llm-cache.service';
import { CacheService } from '../cache/cache.service';
import type { GenerateAgentDto, GenerateAgentResult } from '@voiceforge/shared';

describe('LlmCacheService', () => {
  let cacheService: Partial<CacheService>;
  let service: LlmCacheService;

  beforeEach(() => {
    cacheService = {
      get: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
    };
    service = new LlmCacheService(cacheService as CacheService);
  });

  // --- buildKey tests ---

  describe('buildKey', () => {
    it('returns same key for identical inputs', () => {
      const input: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { industry: 'tech' },
        knowledge_source_ids: [],
      };
      const key1 = service.buildKey(input);
      const key2 = service.buildKey(input);
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^llm:gen:[a-f0-9]{32}$/);
    });

    it('key order independence for business_context', () => {
      const input1: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { a: '1', b: '2', c: '3' },
        knowledge_source_ids: [],
      };
      const input2: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { c: '3', a: '1', b: '2' },
        knowledge_source_ids: [],
      };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });

    it('different keys for different prompts', () => {
      const base: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: {},
        knowledge_source_ids: [],
      };
      const key1 = service.buildKey(base);
      const key2 = service.buildKey({ ...base, prompt: 'Create a sales agent' });
      expect(key1).not.toBe(key2);
    });

    it('ignores null/empty values in business_context', () => {
      const input1: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { a: '1', b: null as unknown as string, c: undefined as unknown as string, d: '', e: '2' },
        knowledge_source_ids: [],
      };
      const input2: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { a: '1', e: '2' },
        knowledge_source_ids: [],
      };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });

    it('sorts knowledge_source_ids', () => {
      const input1: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: {},
        knowledge_source_ids: ['c', 'a', 'b'],
      };
      const input2: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: {},
        knowledge_source_ids: ['a', 'b', 'c'],
      };
      expect(service.buildKey(input1)).toBe(service.buildKey(input2));
    });
  });

  // --- get tests ---

  describe('get', () => {
    it('returns cached result on hit', async () => {
      const result: GenerateAgentResult = {
        agentSpec: { name: 'test-agent', version: '1.0.0' } as import('@voiceforge/shared').AgentSpec,
        validation: { valid: true, errors: [] },
        cached: false,
        generationMs: 100,
      };
      (cacheService.get as ReturnType<typeof vi.fn>).mockResolvedValue(result);

      const cached = await service.get('llm:gen:abc123');
      expect(cached).toEqual(result);
      expect(cacheService.get).toHaveBeenCalledWith('llm:gen:abc123');
    });

    it('returns null on cache miss', async () => {
      (cacheService.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const cached = await service.get('llm:gen:abc123');
      expect(cached).toBeNull();
    });

    it('returns null on Redis error (with warning log)', async () => {
      const warnSpy = vi.spyOn(service['logger'], 'warn');
      (cacheService.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis connection refused'));

      const cached = await service.get('llm:gen:abc123');
      expect(cached).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith('[llm-cache] Redis get failed: Redis connection refused. Treating as miss.');
    });
  });

  // --- set tests ---

  describe('set', () => {
    it('calls cache.set with correct TTL', async () => {
      const result: GenerateAgentResult = {
        agentSpec: { name: 'test-agent', version: '1.0.0' } as import('@voiceforge/shared').AgentSpec,
        validation: { valid: true, errors: [] },
        cached: false,
        generationMs: 100,
      };
      (cacheService.set as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await service.set('llm:gen:abc123', result);
      expect(cacheService.set).toHaveBeenCalledWith('llm:gen:abc123', result, 86400);
    });

    it('no throw on Redis error', async () => {
      const warnSpy = vi.spyOn(service['logger'], 'warn');
      (cacheService.set as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Redis connection refused'));

      await expect(service.set('llm:gen:abc123', {} as GenerateAgentResult)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith('[llm-cache] Redis set failed: Redis connection refused. Skipping cache.');
    });
  });
});