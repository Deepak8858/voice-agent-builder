import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VapiVoiceAdapter } from './vapi.adapter';
import type { CreateRuntimeAgentInput } from './voice.provider.interface';

vi.mock('../../config/env', () => ({
  env: { VAPI_API_KEY: 'test-key' },
}));

// Mock PrismaService — needed because adapter now persists providerRuntimeId to DB (Phase 1.2)
const mockPrisma = {
  agentVersion: {
    update: vi.fn().mockResolvedValue(undefined),
    findUnique: vi.fn().mockResolvedValue({ providerRuntimeId: 'mock-runtime-id' }),
  },
};

// Use real Response objects so .json() works properly
function jsonResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), { status: 200, ...init });
}

function errorResponse(status: number, statusText: string, bodyText: string) {
  return new Response(bodyText, { status, statusText });
}

function makeSpec(overrides: Partial<CreateRuntimeAgentInput['spec']> = {}): CreateRuntimeAgentInput['spec'] {
  return {
    schema_version: '1.0',
    name: 'Test Agent',
    industry: 'dental',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { voice_id: 'female-1', tone: 'friendly', allow_interruptions: true },
    identity: { business_name: 'Test Corp', agent_name: 'Alice', disclosure: 'Hi, I am Alice' },
    goals: ['answer calls', 'book appointments'],
    required_fields: [],
    conversation_rules: { ask_one_question_at_a_time: true, confirm_critical_information: true, do_not_make_up_answers: true, fallback_to_human_when_unsure: true },
    knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
    tools: [{ name: 'google_calendar.book_slot', description: 'Book slot', requires_confirmation: true, input_schema: { type: 'object', properties: {}, required: [] } }],
    handoff: { enabled: true, conditions: ['caller_requests_human'] },
    compliance: { ai_disclosure_required: true, recording_notice_required: false, opt_out_enabled: true, consent_required_for_outbound: true },
    analytics: { success_events: [] },
    ...overrides,
  };
}

describe('VapiVoiceAdapter', () => {
  let adapter: VapiVoiceAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock returns
    mockPrisma.agentVersion.update.mockResolvedValue(undefined);
    mockPrisma.agentVersion.findUnique.mockResolvedValue({ providerRuntimeId: null });
    adapter = new VapiVoiceAdapter(mockPrisma as unknown as Parameters<typeof VapiVoiceAdapter.prototype.createAgent>[0] extends { prisma: infer P } ? P : never);
  });

  describe('createAgent', () => {
    it('creates Vapi assistant and returns runtime ID', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'vapi-assistant-123' }));

      const result = await adapter.createAgent({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'v-1',
        spec: makeSpec(),
      });

      expect(result.provider_runtime_id).toBe('vapi-assistant-123');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.vapi.ai/assistant',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('sets voiceforge metadata on assistant payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'aid-meta' }));

      await adapter.createAgent({
        workspaceId: 'ws-meta', agentId: 'ag-meta', agentVersionId: 'v-meta',
        spec: makeSpec(),
      });

      const req = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse(req[1]!.body as string);
      expect(body.metadata.voiceforge_agent_id).toBe('ag-meta');
      expect(body.metadata.voiceforge_workspace_id).toBe('ws-meta');
      expect(body.metadata.voiceforge_agent_version_id).toBe('v-meta');
    });
  });

  describe('startOutboundCall', () => {
    it('starts outbound call with phone number', async () => {
      // Mock findUnique to return providerRuntimeId so startOutboundCall can find the assistant
      mockPrisma.agentVersion.findUnique.mockResolvedValue({ providerRuntimeId: 'vapi-asst-outbound' });
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'call-456', status: 'queued' }));

      const result = await adapter.startOutboundCall({
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        agentVersionId: 'vapi-asst-outbound',
        toNumber: '+14155551234',
        fromNumber: '+15550000000',
      });

      expect(result.provider_call_id).toBe('call-456');
      expect(result.status).toBe('queued');
      const req = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse(req[1]!.body as string);
      expect(body.customer.number).toBe('+14155551234');
      expect(body.assistantId).toBe('vapi-asst-outbound');
    });

    it('returns ringing status when call status is ringing', async () => {
      mockPrisma.agentVersion.findUnique.mockResolvedValue({ providerRuntimeId: 'a1-ringing' });
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ id: 'c1', status: 'ringing' }));

      const result = await adapter.startOutboundCall({
        workspaceId: 'ws', agentId: 'ag', agentVersionId: 'a1-ringing', toNumber: '+14155550000',
      });
      expect(result.status).toBe('ringing');
    });

    it('throws when assistant not found', async () => {
      // Return null providerRuntimeId so the "not found" path is triggered
      mockPrisma.agentVersion.findUnique.mockResolvedValue(null);

      await expect(adapter.startOutboundCall({
        workspaceId: 'ws', agentId: 'ag', agentVersionId: 'unknown-id', toNumber: '+14155550000',
      })).rejects.toThrow('No vapi assistant found');
    });
  });

  describe('endCall', () => {
    it('calls correct endpoint with POST', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

      await adapter.endCall({ callId: 'call-123', reason: 'completed' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.vapi.ai/call/call-123/end',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('sends reason in body when provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

      await adapter.endCall({ callId: 'call-123', reason: 'user_requested' });
      const req = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse(req[1]!.body as string);
      expect(body.reason).toBe('user_requested');
    });
  });

  describe('getTranscript', () => {
    it('maps assistant role to agent speaker', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        segments: [
          { role: 'assistant', text: 'Hello there', startTime: 0.4 },
          { role: 'customer', text: 'Hi', startTime: 1.8 },
        ],
      }));

      const result = await adapter.getTranscript({ callId: 'call-abc' });

      expect(result.turns[0]!.speaker).toBe('agent');
      expect(result.turns[0]!.text).toBe('Hello there');
      expect(result.turns[0]!.at_ms).toBe(400);
      expect(result.turns[1]!.speaker).toBe('caller');
      expect(result.turns[1]!.text).toBe('Hi');
      expect(result.turns[1]!.at_ms).toBe(1800);
    });

    it('returns transcript string in role: text format', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({
        segments: [
          { role: 'assistant', text: 'Hello.', startTime: 0 },
        ],
      }));

      const result = await adapter.getTranscript({ callId: 'call-x' });
      expect(result.transcript).toContain('assistant: Hello.');
    });

    it('handles empty segments', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ segments: [] }));
      const result = await adapter.getTranscript({ callId: 'call-empty' });
      expect(result.turns).toHaveLength(0);
      expect(result.transcript).toBe('');
    });
  });

  describe('transferCall', () => {
    it('transfers call to target number', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

      await adapter.transferCall({ callId: 'call-1', targetNumber: '+18005559999' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.vapi.ai/call/call-1/transfer',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('getRecording', () => {
    it('returns recording URL and duration', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({ url: 'https://recordings.example.com/call-1.mp3', duration: 65 }),
      );

      const result = await adapter.getRecording({ callId: 'call-1' });
      expect(result.url).toBe('https://recordings.example.com/call-1.mp3');
      expect(result.duration_seconds).toBe(65);
    });

    it('handles null URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ url: null, duration: null }));
      const result = await adapter.getRecording({ callId: 'call-1' });
      expect(result.url).toBeNull();
    });
  });

  describe('error handling', () => {
    it('throws AppError on HTTP 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(401, 'Unauthorized', 'Invalid API key'));

      await expect(adapter.createAgent({
        workspaceId: 'ws', agentId: 'ag', agentVersionId: 'v',
        spec: makeSpec(),
      })).rejects.toThrow('Vapi API error 401');
    });

    it('throws AppError on HTTP 404', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(errorResponse(404, 'Not Found', 'Call not found'));

      await expect(adapter.getTranscript({ callId: 'nonexistent' })).rejects.toThrow('Vapi API error 404');
    });
  });
});
