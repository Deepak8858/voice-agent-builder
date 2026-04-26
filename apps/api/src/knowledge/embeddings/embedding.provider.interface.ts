/**
 * Embedding provider adapter interface. Per AGENTS.md rule #4 (no hard-coded
 * provider) and rule #10 (mock first, preserve real interface).
 *
 * All adapters MUST return fixed-dimension dense float vectors. Mock and real
 * adapters share the same dimension within a deployment so cosine similarity
 * across stored chunks is meaningful.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_PROVIDER_TOKEN = Symbol.for('EMBEDDING_PROVIDER_TOKEN');
