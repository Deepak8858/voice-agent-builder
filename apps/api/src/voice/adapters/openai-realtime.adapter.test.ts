import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';

const envState = vi.hoisted(() => ({
  OPENAI_REALTIME_BASE_URL: 'https://api.openai.com/v1',
  OPENAI_REALTIME_MODEL: 'gpt-realtime',
  OPENAI_REALTIME_VOICE: 'marin',
} as {
  OPENAI_API_KEY?: string;
  OPENAI_REALTIME_BASE_URL: string;
  OPENAI_REALTIME_MODEL: string;
  OPENAI_REALTIME_VOICE: string;
}));

vi.mock('../../config/env', () => ({
  env: envState,
}));

import { OpenAIRealtimeVoiceAdapter } from './openai-realtime.adapter';

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Front Desk',
    industry: 'dental',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'friendly', allow_interruptions: true },
    identity: {
      business_name: 'Acme Dental',
      agent_name: 'Ava',
      disclosure: 'Hi, I am Ava, an AI assistant.',
    },
    goals: ['answer questions', 'book appointments'],
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
    ...overrides,
  } as AgentSpec;
}

const mockPrisma = {
  agentVersion: {
    update: vi.fn(),
    findUnique: vi.fn(),
  },
};

describe('OpenAIRealtimeVoiceAdapter', () => {
  let adapter: OpenAIRealtimeVoiceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    delete envState.OPENAI_API_KEY;
    envState.OPENAI_REALTIME_BASE_URL = 'https://api.openai.com/v1';
    envState.OPENAI_REALTIME_MODEL = 'gpt-realtime';
    envState.OPENAI_REALTIME_VOICE = 'marin';
    mockPrisma.agentVersion.update.mockResolvedValue(undefined);
    mockPrisma.agentVersion.findUnique.mockResolvedValue({
      providerRuntimeId: 'openai_rt_v1',
      specJson: makeSpec(),
    });
    globalThis.fetch = vi.fn();
    adapter = new OpenAIRealtimeVoiceAdapter(mockPrisma as never);
  });

  it('creates and persists a deterministic runtime id without calling OpenAI', async () => {
    const result = await adapter.createAgent({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      agentVersionId: 'v1',
      spec: makeSpec(),
    });

    expect(result.provider_runtime_id).toBe('openai_rt_v1');
    expect(mockPrisma.agentVersion.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { providerRuntimeId: 'openai_rt_v1' },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('creates a realtime client secret for browser test sessions when OPENAI_API_KEY is set', async () => {
    envState.OPENAI_API_KEY = 'test-key';
    const specWithTools = makeSpec({
      tools: [
        {
          name: 'google_calendar_booking',
          description: 'Finds free slots and creates calendar events.',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            properties: {
              operation: { type: 'string', enum: ['find_free_slot', 'create_event'] },
              start_iso: { type: 'string' },
              end_iso: { type: 'string' },
            },
            required: ['operation'],
          },
        },
      ],
      flow: {
        start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'start', next: 'ask_slot' },
          { id: 'ask_slot', type: 'ask_question', question: 'What time works for you?', capture_field: 'preferred_time', next: 'book' },
          { id: 'book', type: 'tool_call', tool_name: 'google_calendar_booking', next: 'end' },
          { id: 'end', type: 'end' },
        ],
      },
    });
    mockPrisma.agentVersion.findUnique.mockResolvedValue({
      providerRuntimeId: 'openai_rt_v1',
      specJson: specWithTools,
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        // Top-level secret, as the GA /realtime/client_secrets endpoint returns it.
        JSON.stringify({
          value: 'ek_test',
          expires_at: 1893456000,
          session: { type: 'realtime' },
        }),
        { status: 200 },
      ),
    );

    const result = await adapter.createBrowserTestSession({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      agentVersionId: 'v1',
    });

    expect(result.token).toBe('ek_test');
    expect(result.web_socket_url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/client_secrets',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]![1]!.body as string);
    expect(body.session).toEqual(
      expect.objectContaining({
        type: 'realtime',
        model: 'gpt-realtime',
        instructions: expect.stringContaining('Conversation flow'),
      }),
    );
    expect(body.session.instructions).toContain('ask "What time works for you?"');
    expect(body.session.instructions).toContain('call tool google_calendar_booking');
    expect(body.session.audio.output.voice).toBe('marin');
    expect(body.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(body.session.audio.output.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(body.session.tool_choice).toBe('auto');
    expect(body.session.tools).toEqual([
      {
        type: 'function',
        name: 'google_calendar_booking',
        description: 'Finds free slots and creates calendar events.',
        parameters: specWithTools.tools[0]!.input_schema,
      },
    ]);
  });

  it('returns a mock browser test session and scripted transcript when credentials are unavailable', async () => {
    const result = await adapter.createBrowserTestSession({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      agentVersionId: 'v1',
    });

    expect(result.test_session_id).toMatch(/^openai_mock_test_v1_/);
    expect(result.token).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const transcript = await adapter.getTranscript({ callId: result.test_session_id });
    expect(transcript.turns[0]).toEqual(
      expect.objectContaining({ speaker: 'agent', text: expect.stringContaining('Acme Dental') }),
    );
    expect(transcript.turns).toContainEqual(expect.objectContaining({ speaker: 'caller' }));
  });

  it('queues mock outbound calls without credentials', async () => {
    const result = await adapter.startOutboundCall({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      agentVersionId: 'v1',
      toNumber: '+14155550123',
    });

    expect(result).toEqual({
      provider_call_id: 'openai_mock_call_v1_14155550123',
      status: 'queued',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('normalizes webhook event names and call identifiers', async () => {
    const result = await adapter.handleWebhook({
      type: 'realtime.call.incoming',
      call_id: 'call_123',
    });

    expect(result).toEqual({
      event: 'call.started',
      callId: 'call_123',
      processed: true,
    });
  });
});
