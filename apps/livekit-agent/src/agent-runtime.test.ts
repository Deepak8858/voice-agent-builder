import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import {
  buildVoiceForgeInstructions,
  firstReplyInstruction,
  parseDispatchMetadata,
  resolveRealtimeVoice,
} from './agent-runtime';

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

describe('LiveKit agent runtime helpers', () => {
  it('requires structured dispatch metadata with an agent id', () => {
    expect(parseDispatchMetadata(JSON.stringify({ workspaceId: 'ws-1', agentId: 'agent-1' }))).toEqual({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
    });

    expect(() => parseDispatchMetadata('{}')).toThrow(/agentId/);
    expect(() => parseDispatchMetadata('not json')).toThrow(/metadata/);
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
    expect(resolveRealtimeVoice({ ...spec, voice: { ...spec.voice, voice_id: undefined } }, 'coral')).toBe('coral');
  });
});
