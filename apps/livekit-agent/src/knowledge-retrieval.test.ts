import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec, KnowledgeSearchHit } from '@voiceforge/shared';
import {
  createKnowledgeSearchClient,
  createKnowledgeTool,
  retrievalChunkLimit,
} from './knowledge-retrieval';

function makeSpec(knowledge: AgentSpec['knowledge']): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Knowledge agent',
    industry: 'support',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'professional', allow_interruptions: true },
    identity: { business_name: 'VoiceForge', agent_name: 'Support' },
    goals: ['Answer questions'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge,
    tools: [],
    handoff: { enabled: false, conditions: [] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
  };
}

const hit: KnowledgeSearchHit = {
  chunk_id: '11111111-1111-4111-8111-111111111111',
  source_id: '22222222-2222-4222-8222-222222222222',
  source_title: 'Policies',
  source_type: 'text',
  agent_id: null,
  chunk_index: 0,
  content: 'Refunds are available for 30 days.',
  score: 1,
};

describe('LiveKit knowledge retrieval', () => {
  it('disables retrieval for none mode or zero chunks', () => {
    expect(retrievalChunkLimit(makeSpec({ retrieval_mode: 'none', max_chunks: 20, source_ids: [] }))).toBe(0);
    expect(retrievalChunkLimit(makeSpec({ retrieval_mode: 'agent_scoped', max_chunks: 0, source_ids: [] }))).toBe(0);
    expect(createKnowledgeTool({
      spec: makeSpec({ retrieval_mode: 'none', max_chunks: 5, source_ids: [] }),
      agentId: 'agent-1',
      callId: 'call-1',
      search: vi.fn(),
    })).toBeUndefined();
  });

  it('uses closure-derived agent scope and limits returned passages', async () => {
    const search = vi.fn(async () => [hit, { ...hit, chunk_id: 'chunk-2' }]);
    const tool = createKnowledgeTool({
      spec: makeSpec({ retrieval_mode: 'agent_scoped', max_chunks: 1, source_ids: [] }),
      agentId: 'trusted-agent-id',
      callId: 'call-1',
      search,
    });

    expect(tool?.parameters).not.toHaveProperty('workspaceId');
    const result = await tool!.execute({ query: 'What is the refund policy?' }, {} as never);

    expect(search).toHaveBeenCalledWith({
      agentId: 'trusted-agent-id',
      callId: 'call-1',
      query: 'What is the refund policy?',
      maxChunks: 1,
      retrievalMode: 'agent_scoped',
    });
    expect(result).toMatchObject({ found: true, passages: [{ content: hit.content }] });
  });

  it('returns the configured fallback when retrieval fails', async () => {
    const tool = createKnowledgeTool({
      spec: makeSpec({
        retrieval_mode: 'workspace_scoped',
        max_chunks: 5,
        source_ids: [],
        fallback_message: 'Let me have the team follow up.',
      }),
      agentId: 'trusted-agent-id',
      callId: 'call-1',
      search: vi.fn(async () => { throw new Error('unavailable'); }),
    });

    await expect(tool!.execute({ query: 'Unknown' }, {} as never)).resolves.toEqual({
      found: false,
      fallback_message: 'Let me have the team follow up.',
    });
  });

  it('sends query, server-selected retrieval configuration, and the bound call id to the API', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { hits: [hit] },
      error: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const search = createKnowledgeSearchClient({
      apiBaseUrl: 'http://api:4000/',
      internalApiKey: 'internal-key',
      fetchImpl,
    });

    await search({
      agentId: 'agent/one',
      callId: 'call-1',
      query: 'refunds',
      maxChunks: 5,
      retrievalMode: 'workspace_scoped',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://api:4000/api/v1/internal/livekit/agents/agent%2Fone/knowledge/search',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-internal-key': 'internal-key' }),
        body: JSON.stringify({
          query: 'refunds',
          max_chunks: 5,
          retrieval_mode: 'workspace_scoped',
          call_id: 'call-1',
        }),
      }),
    );
  });
});
