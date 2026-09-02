import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import type { z } from 'zod';
import {
  buildVoiceForgeInstructions,
  firstReplyInstruction,
  parseDispatchMetadata,
  resolveRealtimeVoice,
} from './agent-runtime';
import { createGoogleTools, createToolInvokeClient } from './google-tools';

const spec: AgentSpec = {
  schema_version: '1.0',
  name: 'VoiceForge QA Survey',
  industry: 'testing',
  agent_type: 'outbound_survey',
  language: 'en',
  voice: { tone: 'calm and professional', voice_id: 'marin', allow_interruptions: true },
  identity: {
    business_name: 'VoiceForge',
    agent_name: 'Deepak QA Agent',
    disclosure: 'I am an AI voice assistant calling from VoiceForge.',
  },
  goals: ['Confirm the recipient can hear the agent', 'Ask one short QA question'],
  required_fields: [],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
    first_message: 'Hello, this is Deepak QA Agent from VoiceForge. Can you hear me clearly?',
  },
  knowledge: { retrieval_mode: 'none', max_chunks: 0, source_ids: [] },
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

describe('LiveKit Google tool invocation', () => {
  it('sends a deterministic idempotency key for Calendar creates only', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          success: true,
          data: { status: 'success', result: { event_id: 'evt-1' }, error_message: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const invoke = createToolInvokeClient({
      apiBaseUrl: 'http://api:4000',
      internalApiKey: 'internal-key',
      agentId: 'agent-1',
      callId: 'call-1',
      fetchImpl,
    });

    await invoke(
      'calendar',
      { operation: 'create_event', start_iso: '2026-08-24T10:00:00Z', summary: 'Demo' },
      'google_calendar',
    );
    await invoke(
      'calendar',
      { summary: 'Demo', operation: 'create_event', start_iso: '2026-08-24T10:00:00Z' },
      'google_calendar',
    );
    await invoke('calendar', { operation: 'list_events' }, 'google_calendar');

    expect(bodies[0]?.idempotency_key).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1]?.idempotency_key).toBe(bodies[0]?.idempotency_key);
    expect(bodies[2]).not.toHaveProperty('idempotency_key');
  });
});

describe('LiveKit Sheets tool parameters', () => {
  const sheetsSpec: AgentSpec = {
    ...spec,
    tools: [
      {
        name: 'append_sheet_row',
        description: 'Append a row.',
        requires_confirmation: true,
        input_schema: { type: 'object', properties: {}, required: ['values'] },
        permissions: ['google_sheets'],
      },
    ],
  };

  // The framework validates arguments before execute runs, so a schema that
  // rejects `null` silently drops the whole tool call: the row is never sent.
  it('accepts an empty cell and offers the model no spreadsheet choice', () => {
    const [tool] = createGoogleTools({ spec: sheetsSpec, invoke: vi.fn() });
    const parameters = (tool as unknown as { parameters: z.ZodObject<z.ZodRawShape> }).parameters;

    expect(parameters.safeParse({ values: ['Deepak', null, 3, true] }).success).toBe(true);
    expect(Object.keys(parameters.shape)).toEqual(['values']);
  });

  it('tells the model the destination is preconfigured', () => {
    const instructions = buildVoiceForgeInstructions(sheetsSpec, {
      agentId: 'agent-1',
      direction: 'inbound',
    });

    expect(instructions).toContain('call append_sheet_row once');
    expect(instructions).toContain('do not choose or invent a spreadsheet');
  });
});

describe('LiveKit agent runtime helpers', () => {
  it('requires structured dispatch metadata with an agent id', () => {
    // Jobs enqueued before the dual-pipeline release carry no pipeline, and must
    // keep running on the behavior they were created with.
    expect(
      parseDispatchMetadata(JSON.stringify({ workspaceId: 'ws-1', agentId: 'agent-1' })),
    ).toEqual({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      pipeline: 'realtime',
    });

    expect(() => parseDispatchMetadata('{}')).toThrow(/agentId/);
    expect(() => parseDispatchMetadata('not json')).toThrow(/metadata/);
  });

  it('carries an explicit standard pipeline through dispatch metadata', () => {
    const metadata = parseDispatchMetadata(
      JSON.stringify({ agentId: 'agent-1', pipeline: 'standard' }),
    );
    expect(metadata.pipeline).toBe('standard');
  });

  /**
   * `startTestSession` dispatches `direction: 'browser_test'`. A narrower enum
   * here rejected it — `.passthrough()` tolerates unknown keys, not a known key
   * with an out-of-enum value — so every test session threw in `entry()` before
   * connecting. Pinned per direction the API actually sends.
   */
  it.each(['inbound', 'outbound', 'browser_test'] as const)(
    'accepts the %s direction the API dispatches',
    (direction) => {
      expect(parseDispatchMetadata(JSON.stringify({ agentId: 'agent-1', direction })))
        .toMatchObject({ direction });
    },
  );

  it('accepts only a positive integer hard duration cap', () => {
    expect(parseDispatchMetadata(JSON.stringify({ agentId: 'agent-1', maxDurationSeconds: 125 })))
      .toMatchObject({ maxDurationSeconds: 125 });
    expect(() => parseDispatchMetadata(JSON.stringify({ agentId: 'agent-1', maxDurationSeconds: 0 })))
      .toThrow(/agentId/);
    expect(() => parseDispatchMetadata(JSON.stringify({ agentId: 'agent-1', maxDurationSeconds: 1.5 })))
      .toThrow(/agentId/);
  });

  it('builds speaking instructions from Agent Spec JSON', () => {
    const instructions = buildVoiceForgeInstructions(spec, {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      direction: 'outbound',
    });

    expect(instructions).toContain('Deepak QA Agent');
    expect(instructions).toContain('VoiceForge');
    expect(instructions).toContain('I am an AI voice assistant calling from VoiceForge.');
    expect(instructions).toContain('Confirm the recipient can hear the agent');
    expect(instructions).toContain('ask one question at a time');
    expect(instructions).toContain('respect opt-out requests');
  });

  it('uses the spec first message and voice override for the realtime session', () => {
    expect(firstReplyInstruction(spec)).toBe(
      'Say exactly: "Hello, this is Deepak QA Agent from VoiceForge. Can you hear me clearly?"',
    );
    expect(resolveRealtimeVoice(spec, 'coral')).toBe('marin');
    expect(
      resolveRealtimeVoice({ ...spec, voice: { ...spec.voice, voice_id: undefined } }, 'coral'),
    ).toBe('coral');
  });
});

describe('LiveKit reminder instructions', () => {
  it('gives the model the current time and the reminder tool only when the workspace has a calendar', () => {
    const now = new Date('2026-09-02T18:30:00.000Z');
    const withTool = buildVoiceForgeInstructions(
      spec,
      { agentId: 'agent-1', direction: 'inbound', pipeline: 'realtime' },
      { reminderTool: true, now },
    );
    const without = buildVoiceForgeInstructions(spec, {
      agentId: 'agent-1',
      direction: 'inbound',
      pipeline: 'realtime',
    });
    expect(withTool).toContain('2026-09-02T18:30:00.000Z');
    expect(withTool).toContain('call schedule_reminder');
    expect(without).not.toContain('schedule_reminder');
  });
});

describe('LiveKit handoff instructions', () => {
  const handoffSpec: AgentSpec = {
    ...spec,
    handoff: { enabled: true, target_phone: '8858901717', conditions: ['caller_requests_human'] },
  };

  it('tells the model to hold the caller and call transfer_to_human on a phone call', () => {
    const instructions = buildVoiceForgeInstructions(handoffSpec, {
      agentId: 'agent-1',
      direction: 'inbound',
      pipeline: 'realtime',
    });

    expect(instructions).toContain('call transfer_to_human');
    expect(instructions).toContain('caller_requests_human');
  });

  it('offers a message instead when there is nobody to dial or no line to dial on', () => {
    const noTarget = buildVoiceForgeInstructions(
      { ...handoffSpec, handoff: { enabled: true, conditions: [] } },
      { agentId: 'agent-1', direction: 'inbound', pipeline: 'realtime' },
    );
    const browserTest = buildVoiceForgeInstructions(handoffSpec, {
      agentId: 'agent-1',
      direction: 'browser_test',
      pipeline: 'realtime',
    });

    for (const instructions of [noTarget, browserTest]) {
      expect(instructions).not.toContain('transfer_to_human');
      expect(instructions).toContain('offer to take a message');
    }
  });
});
