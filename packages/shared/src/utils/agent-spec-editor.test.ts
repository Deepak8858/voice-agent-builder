import { describe, expect, it } from 'vitest';
import { AgentSpecSchema, type AgentSpec } from '../schemas/agent-spec';
import { setAgentSpecPath, summarizeAgentSpecIssues } from './agent-spec-editor';

const minimalSpec: AgentSpec = {
  schema_version: '1.0',
  name: 'Basic AI Receptionist',
  industry: 'general_smb',
  agent_type: 'inbound_receptionist',
  language: 'en',
  voice: { tone: 'friendly and professional', allow_interruptions: true },
  identity: { business_name: 'Example Business', agent_name: 'Ava' },
  goals: ['answer calls'],
  required_fields: [],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
  },
  knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
  tools: [],
  handoff: { enabled: true, conditions: ['caller_requests_human'] },
  compliance: {
    ai_disclosure_required: true,
    recording_notice_required: false,
    opt_out_enabled: true,
    consent_required_for_outbound: true,
  },
  analytics: { success_events: [] },
};

describe('agent spec editor helpers', () => {
  it('updates nested Agent Spec fields without mutating the original spec', () => {
    const updated = setAgentSpecPath(
      minimalSpec,
      'conversation_rules.first_message',
      'Thanks for calling Example Business.',
    );

    expect(updated).not.toBe(minimalSpec);
    expect(minimalSpec.conversation_rules.first_message).toBeUndefined();
    expect(
      (updated as AgentSpec).conversation_rules.first_message,
    ).toBe('Thanks for calling Example Business.');
    expect(AgentSpecSchema.safeParse(updated).success).toBe(true);
  });

  it('formats validation issues with field paths', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimalSpec,
      identity: { ...minimalSpec.identity, business_name: '' },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(summarizeAgentSpecIssues(parsed.error)).toContain(
        'identity.business_name: String must contain at least 1 character(s)',
      );
    }
  });
});
