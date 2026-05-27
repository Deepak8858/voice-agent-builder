import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

describe('LlmModule', () => {
  it('makes the OpenAI embeddings adapter injectable for worker modules', async () => {
    process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough';
    process.env.REDIS_URL = 'redis://localhost:6379';

    const [{ OpenAiEmbeddingsAdapter }, { LlmModule }] = await Promise.all([
      import('./adapters/openai-embeddings.adapter'),
      import('./llm.module'),
    ]);
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, LlmModule) ?? [];
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, LlmModule) ?? [];

    expect(providers).toContain(OpenAiEmbeddingsAdapter);
    expect(exports).toContain(OpenAiEmbeddingsAdapter);
  }, 10_000);
});
