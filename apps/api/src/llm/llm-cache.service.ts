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