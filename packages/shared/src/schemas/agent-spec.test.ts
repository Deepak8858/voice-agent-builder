import { describe, expect, it } from 'vitest';
import { AgentSpecSchema } from './agent-spec';
import { MVP_TEMPLATES } from '../constants/templates';

/**
 * Minimal fixture mirroring docs/28_SAMPLE_AGENT_SPECS.md "Minimal Agent Spec".
 */
const minimal = {
  schema_version: '1.0' as const,
  name: 'Basic AI Receptionist',
  industry: 'general_smb',
  agent_type: 'inbound_receptionist' as const,
  language: 'en',
  voice: { tone: 'friendly and professional', allow_interruptions: true },
  identity: { business_name: 'Example Business', agent_name: 'Ava' },
  goals: ['answer calls', 'collect contact details', 'take message'],
  required_fields: [
    { key: 'full_name', type: 'string' as const, required: true },
    { key: 'phone', type: 'phone' as const, required: true },
  ],
  tools: [],
  handoff: { enabled: true, conditions: ['caller_requests_human', 'agent_uncertain'] },
  compliance: {
    ai_disclosure_required: true,
    recording_notice_required: false,
    opt_out_enabled: true,
    consent_required_for_outbound: true,
  },
  analytics: { success_events: ['message_taken', 'human_transfer_completed'] },
};

describe('AgentSpecSchema', () => {
  it('accepts the minimal sample spec', () => {
    const parsed = AgentSpecSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
  });

  it('accepts every MVP template spec', () => {
    for (const template of MVP_TEMPLATES) {
      const parsed = AgentSpecSchema.safeParse(template.spec);
      if (!parsed.success) {
        throw new Error(
          `Template "${template.slug}" failed validation:\n` +
            JSON.stringify(parsed.error.flatten(), null, 2),
        );
      }
    }
  });

  it('rejects specs missing compliance', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { compliance: _c, ...bad } = minimal;
    const parsed = AgentSpecSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  it('rejects outbound agents that do not require consent', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      agent_type: 'outbound_reminder',
      compliance: { ...minimal.compliance, consent_required_for_outbound: false },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects handoff enabled with zero conditions', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      handoff: { enabled: true, conditions: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects flow edges that point at missing nodes', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      flow: {
        start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'start', next: 'ask' },
          {
            id: 'ask',
            type: 'ask_question',
            question: 'How can I help?',
            next: 'missing-node',
          },
          {
            id: 'branch',
            type: 'condition',
            expression: "intent === 'urgent'",
            on_true: 'end',
            on_false: 'missing-node',
          },
          { id: 'end', type: 'end' },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('preserves flow node positions', () => {
    const parsed = AgentSpecSchema.parse({
      ...minimal,
      flow: {
        start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'start', next: 'end', position: { x: 12, y: 34 } },
          { id: 'end', type: 'end', position: { x: 56, y: 78 } },
        ],
      },
    });

    expect(parsed.flow?.nodes[0]?.position).toStrictEqual({ x: 12, y: 34 });
  });

  it('rejects flows with multiple start nodes', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      flow: {
        start_node_id: 'start-a',
        nodes: [
          { id: 'start-a', type: 'start', next: 'end' },
          { id: 'start-b', type: 'start', next: 'end' },
          { id: 'end', type: 'end' },
        ],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects unknown agent_type', () => {
    const parsed = AgentSpecSchema.safeParse({ ...minimal, agent_type: 'cold_sales' });
    expect(parsed.success).toBe(false);
  });

  it('drops a partial allowed_call_window instead of rejecting the spec', () => {
    // The model sometimes emits the key with the hour fields missing. A partial
    // window must degrade to "no window" rather than fail the whole spec.
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      compliance: {
        ...minimal.compliance,
        allowed_call_window: { timezone: 'America/New_York' },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.compliance.allowed_call_window).toBeUndefined();
    }
  });

  it('keeps a complete allowed_call_window', () => {
    const parsed = AgentSpecSchema.safeParse({
      ...minimal,
      compliance: {
        ...minimal.compliance,
        allowed_call_window: { timezone: 'America/New_York', start_hour: 9, end_hour: 20 },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.compliance.allowed_call_window).toEqual({
        timezone: 'America/New_York',
        start_hour: 9,
        end_hour: 20,
      });
    }
  });
});
