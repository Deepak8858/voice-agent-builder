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
        business_context: { business_name: 'TechCo' },
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
        business_context: { business_name: 'A', timezone: 'UTC', industry_hint: 'tech' },
        knowledge_source_ids: [],
      };
      const input2: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { industry_hint: 'tech', business_name: 'A', timezone: 'UTC' },
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
        business_context: { business_name: 'A', timezone: null as unknown as string },
        knowledge_source_ids: [],
      };
      const input2: GenerateAgentDto = {
        prompt: 'Create a support agent',
        template_slug: 'support',
        business_context: { business_name: 'A' },
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
        spec: {
          schema_version: '1.0',
          name: 'Test Agent',
          industry: 'healthcare',
          agent_type: 'inbound_receptionist',
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
          knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
          tools: [],
          handoff: { enabled: false, conditions: [] },
          compliance: { ai_disclosure_required: true, recording_notice_required: false, opt_out_enabled: true, consent_required_for_outbound: true },
          analytics: { success_events: [] },
        },
        suggested_name: 'Test Agent',
        rationale: 'Generated from cache test',
        matched_template_slug: 'ai-receptionist',
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
        spec: {
          schema_version: '1.0',
          name: 'Test Agent',
          industry: 'healthcare',
          agent_type: 'inbound_receptionist',
          language: 'en',
          voice: { tone: 'professional', allow_interruptions: true },
          identity: { business_name: 'Test Corp', agent_name: 'Alice' },
          goals: ['Greet caller'],
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
          compliance: { ai_disclosure_required: true, recording_notice_required: false, opt_out_enabled: true, consent_required_for_outbound: true },
          analytics: { success_events: [] },
        },
        suggested_name: 'Test Agent',
        rationale: 'Generated from cache test',
        matched_template_slug: null,
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
