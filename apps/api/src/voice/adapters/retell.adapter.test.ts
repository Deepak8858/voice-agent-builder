import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';

const safeFetchMock = vi.hoisted(() => vi.fn());
const envState = vi.hoisted(() => ({
  RETELL_API_KEY: 'retell-test-key',
  RETELL_BASE_URL: 'https://api.retellai.com',
  RETELL_FROM_NUMBER: '+14155550100',
  RETELL_VOICE_ID: '11labs-Adrian',
}));

vi.mock('../../common/safe-fetch', () => ({ safeFetch: safeFetchMock }));
vi.mock('../../config/env', () => ({ env: envState }));

import { RetellVoiceAdapter } from './retell.adapter';

const spec: AgentSpec = {
  schema_version: '1.0',
  name: 'Front Desk',
  industry: 'dental',
  agent_type: 'inbound_receptionist',
  language: 'en',
  voice: { tone: 'friendly', allow_interruptions: true },
  identity: {
    business_name: 'Acme Dental',
    agent_name: 'Ava',
    disclosure: 'I am an AI assistant.',
  },
  goals: ['book appointments'],
  required_fields: [],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
    first_message: 'Thanks for calling Acme Dental.',
  },
  knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
  tools: [],
  handoff: { enabled: true, conditions: ['caller_requests_human'] },
  compliance: {
    ai_disclosure_required: true,
    recording_notice_required: true,
    opt_out_enabled: true,
    consent_required_for_outbound: true,
  },
  analytics: { success_events: [] },
};

const prisma = {
  agentVersion: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
};

describe('RetellVoiceAdapter', () => {
  let adapter: RetellVoiceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.agentVersion.update.mockResolvedValue(undefined);
    prisma.agentVersion.findUnique.mockResolvedValue({ providerRuntimeId: 'retell-agent-1' });
    adapter = new RetellVoiceAdapter(prisma as never);
  });

  it('creates a Retell LLM and agent, then persists the runtime ID', async () => {
    safeFetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ llm_id: 'llm-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ agent_id: 'agent-1' }), { status: 200 }));

    const result = await adapter.createAgent({
      workspaceId: 'ws-1',
      agentId: 'a-1',
      agentVersionId: 'v-1',
      spec,
    });

    expect(result).toEqual({ provider_runtime_id: 'agent-1' });
    expect(prisma.agentVersion.update).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      data: { providerRuntimeId: 'agent-1' },
    });
    expect(safeFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.retellai.com/create-retell-llm',
      expect.objectContaining({ method: 'POST' }),
    );
    const agentBody = JSON.parse(safeFetchMock.mock.calls[1]![1].body as string);
    expect(agentBody.response_engine).toEqual({ type: 'retell-llm', llm_id: 'llm-1' });
  });

  it('returns Retell access tokens for browser test sessions', async () => {
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ call_id: 'call-1', access_token: 'token-1' }), {
        status: 200,
      }),
    );

    const result = await adapter.createBrowserTestSession({
      workspaceId: 'ws-1',
      agentId: 'a-1',
      agentVersionId: 'v-1',
    });

    expect(result).toEqual(expect.objectContaining({
      test_session_id: 'call-1',
      token: 'token-1',
    }));
  });

  it('maps transcript objects and recordings from the call response', async () => {
    safeFetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({
        transcript_object: [
          { role: 'agent', content: 'Hello', words: [{ start: 0 }] },
          { role: 'user', content: 'Hi', words: [{ start: 1.25 }] },
        ],
        recording_url: 'https://cdn.retellai.com/recording.wav',
        duration_ms: 2500,
      }), { status: 200 }),
    );

    const transcript = await adapter.getTranscript({ callId: 'call-1' });
    const recording = await adapter.getRecording({ callId: 'call-1' });

    expect(transcript.turns).toEqual([
      { speaker: 'agent', text: 'Hello', at_ms: 0 },
      { speaker: 'caller', text: 'Hi', at_ms: 1250 },
    ]);
    expect(recording).toEqual({
      url: 'https://cdn.retellai.com/recording.wav',
      duration_seconds: 2.5,
    });
  });
});
