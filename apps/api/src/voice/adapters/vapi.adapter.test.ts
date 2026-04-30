import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../config/env', () => ({
  env: {
    VAPI_API_KEY: 'test-api-key',
    NODE_ENV: 'test',
  },
}));

import { AppError } from '../../common/errors';
import { VapiVoiceAdapter } from './vapi.adapter';

function makeSpec(overrides: Partial<import('@voiceforge/shared').AgentSpec> = {}) {
  return {
    schema_version: '1.0' as const,
    name: 'Test Agent',
    industry: 'healthcare',
    agent_type: 'inbound_receptionist' as const,
    language: 'en',
    voice: { tone: 'professional', voice_id: undefined as unknown as string },
    identity: { business_name: 'Test Corp', agent_name: 'Alice' },
    goals: ['Greet caller', 'Collect info'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: { retrieval_mode: 'agent_scoped' as const, max_chunks: 5, source_ids: [] },
    tools: [],
    handoff: { enabled: false, conditions: [] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
    ...overrides,
  };
}

const BASE_INPUT = {
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  agentVersionId: 'av-1',
};

describe('VapiVoiceAdapter', () => {
  let originalFetch: typeof globalThis.fetch;
  let adapter: VapiVoiceAdapter;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    adapter = new VapiVoiceAdapter();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -------------------------------------------------------------------------
  // createAgent
  // -------------------------------------------------------------------------
  it('createAgent returns provider_runtime_id from Vapi response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-assistant-123' }), { status: 200 }),
    );

    const result = await adapter.createAgent({ ...BASE_INPUT, spec: makeSpec() });

    expect(result.provider_runtime_id).toBe('vapi-assistant-123');

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(req![1].method).toBe('POST');
    expect(req![0]).toContain('/assistant');
    const body = JSON.parse(req![1].body as string);
    expect(body.name).toBe('Test Agent');
    expect(body.metadata.voiceforge_agent_id).toBe('agent-1');
    expect(body.metadata.voiceforge_workspace_id).toBe('ws-1');
    expect(body.metadata.voiceforge_agent_version_id).toBe('av-1');
  });

  it('createAgent includes systemPrompt built from spec', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-assistant-456' }), { status: 200 }),
    );

    const spec = makeSpec({
      goals: ['Help the caller', 'Schedule appointment'],
      handoff: { enabled: true, target_phone: '+18005551234', conditions: ['human'] },
    });

    await adapter.createAgent({ ...BASE_INPUT, spec });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(req![1].body as string);
    const sysPrompt: string = body.model.systemPrompt;
    expect(sysPrompt).toContain('Help the caller');
    expect(sysPrompt).toContain('Schedule appointment');
    expect(sysPrompt).toContain('Test Corp');
    expect(sysPrompt).toContain('Alice');
  });

  it('createAgent sends voice.voice_id when present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-assistant-789' }), { status: 200 }),
    );

    const spec = makeSpec({ voice: { tone: 'warm', voice_id: 'voice-abc-123' } });
    await adapter.createAgent({ ...BASE_INPUT, spec });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(req![1].body as string);
    expect(body.voice.voiceId).toBe('voice-abc-123');
  });

  it('createAgent sends recording notice when compliance requires it', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-assistant-rec' }), { status: 200 }),
    );

    const spec = makeSpec({
      compliance: {
        ...makeSpec().compliance,
        recording_notice_required: true,
      },
    });

    await adapter.createAgent({ ...BASE_INPUT, spec });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(req![1].body as string);
    expect(body.spcallbacks).toBeDefined();
    expect(body.spcallbacks.onCallStart[0].args.text).toContain('recorded');
  });

  // -------------------------------------------------------------------------
  // startOutboundCall
  // -------------------------------------------------------------------------
  it('startOutboundCall returns provider_call_id and status=queued', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-call-555', status: 'in-progress' }), { status: 200 }),
    );

    // Populate the assistant map so startOutboundCall can look it up
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'vapi-assistant-123' }), { status: 200 }),
    );
    await adapter.createAgent({ ...BASE_INPUT, spec: makeSpec() });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-call-555', status: 'in-progress' }), { status: 200 }),
    );

    const result = await adapter.startOutboundCall({
      ...BASE_INPUT,
      toNumber: '+15551112222',
      fromNumber: '+15553334444',
      metadata: { source: 'web' },
    });

    expect(result.provider_call_id).toBe('vapi-call-555');
    expect(result.status).toBe('queued');

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(req![0]).toContain('/call/outbound');
    const body = JSON.parse(req![1].body as string);
    expect(body.customer.number).toBe('+15551112222');
    expect(body.caller.number).toBe('+15553334444');
    // assistantId is the vapi id from createAgent
    expect(body.assistantId).toBe('vapi-assistant-123');
    expect(body.metadata.voiceforge_agent_id).toBe('agent-1');
    expect(body.metadata.source).toBe('web');
  });

  it('startOutboundCall maps status=ringing correctly', async () => {
    // Populate the assistant map
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'vapi-assistant-ringing' }), { status: 200 }),
    );
    await adapter.createAgent({ ...BASE_INPUT, spec: makeSpec() });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'vapi-call-777', status: 'ringing' }), { status: 200 }),
    );

    const result = await adapter.startOutboundCall({
      ...BASE_INPUT,
      toNumber: '+15551112222',
    });

    expect(result.status).toBe('ringing');
  });

  // -------------------------------------------------------------------------
  // endCall
  // -------------------------------------------------------------------------
  it('endCall calls correct endpoint with optional reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await adapter.endCall({ callId: 'vapi-call-999', reason: 'user_requested' });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(req![0]).toContain('/call/vapi-call-999/end');
    expect(req![1].method).toBe('POST');
    const body = JSON.parse(req![1].body as string);
    expect(body.reason).toBe('user_requested');
  });

  it('endCall works without reason', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await adapter.endCall({ callId: 'vapi-call-999' });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(req![1].body as string);
    expect(body).toEqual({});
  });

  // -------------------------------------------------------------------------
  // transferCall
  // -------------------------------------------------------------------------
  it('transferCall sends POST to correct path with target number', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    await adapter.transferCall({ callId: 'vapi-call-transfer', targetNumber: '+18005559999' });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(req![0]).toContain('/call/vapi-call-transfer/transfer');
    const body = JSON.parse(req![1].body as string);
    expect(body.target).toBe('+18005559999');
  });

  // -------------------------------------------------------------------------
  // getTranscript
  // -------------------------------------------------------------------------
  it('getTranscript maps assistant role to agent speaker', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          segments: [
            { role: 'assistant', text: 'Hello there', startTime: 0.4 },
            { role: 'customer', text: 'Hi', startTime: 1.8 },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await adapter.getTranscript({ callId: 'vapi-call-abc' });

    expect(result.turns[0].speaker).toBe('agent');
    expect(result.turns[0].text).toBe('Hello there');
    expect(result.turns[0].at_ms).toBe(400);
    expect(result.turns[1].speaker).toBe('caller');
    expect(result.turns[1].text).toBe('Hi');
    expect(result.turns[1].at_ms).toBe;
    expect(result.transcript).toContain('assistant: Hello there');
    expect(result.transcript).toContain('customer: Hi');
  });

  it('getTranscript handles empty segments', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ segments: [] }), { status: 200 }),
    );

    const result = await adapter.getTranscript({ callId: 'vapi-call-empty' });

    expect(result.turns).toHaveLength(0);
    expect(result.transcript).toBe('');
  });

  // -------------------------------------------------------------------------
  // getRecording
  // -------------------------------------------------------------------------
  it('getRecording returns url and duration_seconds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://storage.vapi.ai/recording.mp3', duration: 125.5 }), {
        status: 200,
      }),
    );

    const result = await adapter.getRecording({ callId: 'vapi-call-rec' });

    expect(result.url).toBe('https://storage.vapi.ai/recording.mp3');
    expect(result.duration_seconds).toBe(125.5);
  });

  it('getRecording returns nulls when no recording', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: null, duration: null }), { status: 200 }),
    );

    const result = await adapter.getRecording({ callId: 'vapi-call-norec' });

    expect(result.url).toBeNull();
    expect(result.duration_seconds).toBeNull();
  });

  // -------------------------------------------------------------------------
  // updateAgent
  // -------------------------------------------------------------------------
  it('updateAgent PATCHes mutable fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

    const spec = makeSpec({ name: 'Updated Agent' });
    await adapter.updateAgent({
      ...BASE_INPUT,
      provider_runtime_id: 'vapi-asst-upd',
      spec,
    });

    const req = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(req![0]).toContain('/assistant/vapi-asst-upd');
    expect(req![1].method).toBe('PATCH');
    const body = JSON.parse(req![1].body as string);
    expect(body.name).toBe('Updated Agent');
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  it('throws AppError on HTTP 401', async () => {
    // First call createAgent to populate the assistant map
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'vapi-asst-401' }), { status: 200 }),
    );
    await adapter.createAgent({ ...BASE_INPUT, spec: makeSpec() });

    // Second call returns 401 from Vapi API
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    let thrown: unknown;
    try {
      await adapter.startOutboundCall({ ...BASE_INPUT, toNumber: '+15551112222' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).errorCode).toBe('VOICE_PROVIDER_ERROR');
  });

  it('throws AppError on HTTP 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    );

    let thrown: unknown;
    try {
      await adapter.endCall({ callId: 'nonexistent-call' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).errorCode).toBe('VOICE_PROVIDER_ERROR');
  });
});