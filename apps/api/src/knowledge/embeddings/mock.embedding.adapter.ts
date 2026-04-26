import { Injectable } from '@nestjs/common';
import type { EmbeddingProvider } from './embedding.provider.interface';

/**
 * Deterministic mock embedder. Hashes word tokens into a fixed-dim bag-of-words
 * vector then L2-normalizes. Cosine similarity becomes a token-overlap
 * heuristic, which is enough to demo retrieval ranking in the mock build.
 *
 * Same input ALWAYS produces the same vector (test stability).
 */
@Injectable()
export class MockEmbeddingAdapter implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dimensions = 64;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (tokens.length === 0) {
      vec[0] = 1; // avoid zero vector
      return vec;
    }
    for (const tok of tokens) {
      const idx = this.hash(tok) % this.dimensions;
      vec[idx] += 1;
    }
    // L2 normalize
    let mag = 0;
    for (const v of vec) mag += v * v;
    mag = Math.sqrt(mag) || 1;
    for (let i = 0; i < vec.length; i += 1) vec[i] /= mag;
    return vec;
  }

  private hash(s: string): number {
    let h = 2166136261; // FNV-1a 32-bit
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}
