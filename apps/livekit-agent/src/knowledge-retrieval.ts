import { llm } from '@livekit/agents';
import type { AgentSpec, KnowledgeSearchHit } from '@voiceforge/shared';
import { z } from 'zod';

const MAX_RETRIEVAL_CHUNKS = 20;
const DEFAULT_FALLBACK_MESSAGE = 'I do not have that information right now.';

const SearchResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    hits: z.array(z.object({
      chunk_id: z.string(),
      source_id: z.string(),
      source_title: z.string(),
      source_type: z.enum(['url', 'text', 'file']),
      agent_id: z.string().nullable(),
      chunk_index: z.number().int(),
      content: z.string(),
      score: z.number(),
    })),
  }),
});

export interface KnowledgeSearchRequest {
  agentId: string;
  query: string;
  maxChunks: number;
  retrievalMode: 'agent_scoped' | 'workspace_scoped';
}

export type KnowledgeSearch = (request: KnowledgeSearchRequest) => Promise<KnowledgeSearchHit[]>;

export function retrievalChunkLimit(spec: AgentSpec): number {
  if (spec.knowledge.retrieval_mode === 'none') return 0;
  return Math.min(Math.max(spec.knowledge.max_chunks, 0), MAX_RETRIEVAL_CHUNKS);
}

export function createKnowledgeSearchClient(config: {
  apiBaseUrl: string;
  internalApiKey: string;
  fetchImpl?: typeof fetch;
}): KnowledgeSearch {
  const baseUrl = config.apiBaseUrl.replace(/\/$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;

  return async (request) => {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/internal/livekit/agents/${encodeURIComponent(request.agentId)}/knowledge/search`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': config.internalApiKey,
        },
        body: JSON.stringify({
          query: request.query,
          max_chunks: request.maxChunks,
          retrieval_mode: request.retrievalMode,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );

    if (!response.ok) {
      throw new Error(`Knowledge API returned ${response.status}.`);
    }
    return SearchResponseSchema.parse(await response.json()).data.hits;
  };
}

export function createKnowledgeTool(config: {
  spec: AgentSpec;
  agentId: string;
  search: KnowledgeSearch;
}) {
  const maxChunks = retrievalChunkLimit(config.spec);
  if (maxChunks === 0 || config.spec.knowledge.retrieval_mode === 'none') return undefined;

  const fallback = config.spec.knowledge.fallback_message?.trim() || DEFAULT_FALLBACK_MESSAGE;
  const retrievalMode = config.spec.knowledge.retrieval_mode;

  return llm.tool({
    name: 'search_knowledge_base',
    description:
      'Search the configured business knowledge before answering factual questions about the business, its products, services, policies, or procedures. Use only returned passages; if none are returned, say the fallback message exactly.',
    parameters: z.object({
      query: z.string().trim().min(1).max(2000).describe('The caller question or concise search query.'),
    }),
    execute: async ({ query }) => {
      try {
        const hits = await config.search({
          agentId: config.agentId,
          query,
          maxChunks,
          retrievalMode,
        });
        if (hits.length === 0) return { found: false, fallback_message: fallback };
        return {
          found: true,
          passages: hits.slice(0, maxChunks).map((hit) => ({
            content: hit.content,
            source_title: hit.source_title,
          })),
        };
      } catch {
        return { found: false, fallback_message: fallback };
      }
    },
  });
}
