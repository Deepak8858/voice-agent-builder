import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * Standalone OpenAI embeddings adapter for the LLM layer.
 * Uses `text-embedding-3-small` (1536 dims by default).
 *
 * Exposes `generateEmbedding(text)` and `generateEmbeddings(texts[])`
 * which wrap the internal embed call. Uses `OPENAI_API_KEY` from env.
 */
@Injectable()
export class OpenAiEmbeddingsAdapter {
  readonly name = 'openai';
  readonly dimensions = 1536;
  private readonly model = 'text-embedding-3-small';
  private readonly apiKey: string;
  private readonly logger = new Logger(OpenAiEmbeddingsAdapter.name);

  constructor() {
    if (!env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required. Set the key before booting the API.');
    }
    this.apiKey = env.OPENAI_API_KEY;
  }

  /**
   * Generate a single embedding vector for one text.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const [vec] = await this.embed([text]);
    return vec;
  }

  /**
   * Generate embedding vectors for multiple texts in one batch call.
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return this.embed(texts);
  }

  /**
   * Core embed method — call OpenAI embeddings endpoint directly with fetch.
   * Returns a 2D array of vectors in the same order as the input texts.
   */
  private async embed(texts: string[]): Promise<number[][]> {
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