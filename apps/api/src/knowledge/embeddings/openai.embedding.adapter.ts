import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import type { EmbeddingProvider } from './embedding.provider.interface';

/**
 * OpenAI embedding adapter (text-embedding-3-small, 1536 dims by default).
 * Uses fetch directly to avoid pulling the OpenAI SDK as a runtime dep until
 * Phase 10 hardening. If `OPENAI_API_KEY` is missing the constructor throws so
 * the module factory can fall back to the mock adapter.
 */
@Injectable()
export class OpenAIEmbeddingAdapter implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = 1536;
  private readonly model = 'text-embedding-3-small';
  private readonly apiKey: string;
  private readonly logger = new Logger(OpenAIEmbeddingAdapter.name);

  constructor() {
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        'OPENAI_API_KEY is required for OpenAIEmbeddingAdapter. Set EMBEDDING_PROVIDER=mock or configure the key.',
      );
    }
    this.apiKey = env.OPENAI_API_KEY;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`OpenAI embeddings failed: ${res.status} ${body}`);
      throw new Error(`OpenAI embeddings request failed (${res.status}).`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}
