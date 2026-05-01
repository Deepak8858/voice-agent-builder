/**
 * Embedding provider adapter interface. Per AGENTS.md rule #4 (no hard-coded
 * provider).
 *
 * All adapters MUST return fixed-dimension dense float vectors.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER_TOKEN = Symbol.for('EMBEDDING_PROVIDER_TOKEN');
