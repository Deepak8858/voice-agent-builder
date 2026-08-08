import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import type { AgentSpec } from '@voiceforge/shared';
import {
  buildNodeData,
  buildDefaultAgentFlow,
  convertReactFlowToAgentFlow,
  convertAgentFlowToReactFlow,
  createFlowNode,
  getSelectedNode,
  updateNodeData,
  validateAgentFlow,
} from './flow-builder-model';

const nodes: Node[] = [
  { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
  {
    id: 'ask',
    type: 'ask_question',
    position: { x: 0, y: 120 },
    data: { question: 'Old question', capture_field: '' },
  },
];

const defaultSpec: AgentSpec = {
  schema_version: '1.0',
  name: 'Scheduler',
  industry: 'dental',
  agent_type: 'inbound_receptionist',
  language: 'en',
  voice: { tone: 'warm', allow_interruptions: true },
  identity: { business_name: 'Acme Dental', agent_name: 'Ava' },
  goals: ['book appointments'],
  required_fields: [
    { key: 'full_name', type: 'string', required: true },
    { key: 'phone', type: 'phone', required: true },
  ],
  conversation_rules: {
    ask_one_question_at_a_time: true,
    confirm_critical_information: true,
    do_not_make_up_answers: true,
    fallback_to_human_when_unsure: true,
    first_message: 'Thanks for calling Acme Dental.',
  },
  knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
  tools: [
    {
      name: 'google_calendar_booking',
      description: 'Books appointments.',
      requires_confirmation: true,
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ],
  handoff: { enabled: true, conditions: ['caller_requests_human'] },
  compliance: {
    ai_disclosure_required: true,
    recording_notice_required: false,
    opt_out_enabled: true,
    consent_required_for_outbound: true,
  },
  analytics: { success_events: [] },
};

describe('updateNodeData', () => {
  it('returns updated nodes without mutating the original array', () => {
    const updated = updateNodeData(nodes, 'ask', { question: 'New question' });

    expect(nodes[1]?.data.question).toBe('Old question');
    expect(updated[1]?.data.question).toBe('New question');
  });
});

describe('getSelectedNode', () => {
  it('finds the selected node by id', () => {
    const updated = updateNodeData(nodes, 'ask', { question: 'New question' });

    expect(getSelectedNode(updated, 'ask')?.data.question).toBe('New question');
  });

  it('returns null when no node is selected', () => {
    const updated = updateNodeData(nodes, 'ask', { question: 'New question' });

    expect(getSelectedNode(updated, null)).toBeNull();
  });
});

describe('node factories', () => {
  it('builds default data for a send_message node', () => {
    expect(buildNodeData('send_message')).toStrictEqual({ channel: 'sms', body: '' });
  });

  it('creates a tool_call flow node with default data', () => {
    expect(createFlowNode('tool_call', { x: 12, y: 34 }).data).toStrictEqual({ tool_name: '' });
  });
});

describe('buildDefaultAgentFlow', () => {
  const defaultFlow = buildDefaultAgentFlow(defaultSpec);

  it('starts at the start node', () => {
    expect(defaultFlow.start_node_id).toBe('start');
  });

  it('builds nodes in greeting, required-field, tool, and end order', () => {
    expect(defaultFlow.nodes.map((node) => node.type)).toStrictEqual([
      'start',
      'speak',
      'ask_question',
      'ask_question',
      'tool_call',
      'end',
    ]);
  });

  it('links the start node to the greeting', () => {
    expect(defaultFlow.nodes[0]?.next).toBe('greeting');
  });

  it('binds the tool_call node to the spec tool', () => {
    expect((defaultFlow.nodes[4] as { tool_name?: string } | undefined)?.tool_name).toBe(
      'google_calendar_booking',
    );
  });

  it('produces a flow that passes validation', () => {
    expect(validateAgentFlow(defaultFlow)).toStrictEqual([]);
  });
});

describe('convertAgentFlowToReactFlow', () => {
  const converted = convertAgentFlowToReactFlow({
    start_node_id: 'start',
    nodes: [
      { id: 'start', type: 'start', next: 'msg' },
      { id: 'msg', type: 'send_message', body: 'Text body', channel: 'sms', next: 'end' },
      { id: 'end', type: 'end' },
    ],
  });

  it('lays nodes out on a vertical grid', () => {
    expect(converted.nodes.map((node) => node.position)).toStrictEqual([
      { x: 120, y: 40 },
      { x: 120, y: 200 },
      { x: 120, y: 360 },
    ]);
  });

  it('preserves node types and node data', () => {
    expect(converted.nodes[1]?.type).toBe('send_message');
    expect(converted.nodes[1]?.data.body).toBe('Text body');
  });

  it('does not leak canonical next pointers into visual node data', () => {
    expect(converted.nodes[0]?.data.next).toBeUndefined();
  });

  it('converts next pointers into edges', () => {
    expect(converted.edges.map(({ source, target }) => ({ source, target }))).toStrictEqual([
      { source: 'start', target: 'msg' },
      { source: 'msg', target: 'end' },
    ]);
  });
});

describe('convertReactFlowToAgentFlow', () => {
  it('converts visual nodes and edges into the canonical flow', () => {
    const canonical = convertReactFlowToAgentFlow(
      [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
        {
          id: 'ask',
          type: 'ask_question',
          position: { x: 0, y: 140 },
          data: { question: 'What do you need?', capture_field: 'intent' },
        },
        {
          id: 'branch',
          type: 'condition',
          position: { x: 0, y: 280 },
          data: { expression: "intent === 'urgent'" },
        },
        {
          id: 'transfer',
          type: 'transfer',
          position: { x: -160, y: 420 },
          data: { target_phone: '+14155550123' },
        },
        { id: 'end', type: 'end', position: { x: 160, y: 420 }, data: { label: 'End' } },
      ],
      [
        { id: 'e-start-ask', source: 'start', target: 'ask' },
        { id: 'e-ask-branch', source: 'ask', target: 'branch' },
        { id: 'e-branch-true-transfer', source: 'branch', target: 'transfer', sourceHandle: 'true' },
        { id: 'e-branch-false-end', source: 'branch', target: 'end', sourceHandle: 'false' },
      ],
    );

    expect(canonical).toStrictEqual({
      start_node_id: 'start',
      nodes: [
        { id: 'start', type: 'start', label: 'Start', next: 'ask' },
        {
          id: 'ask',
          type: 'ask_question',
          question: 'What do you need?',
          capture_field: 'intent',
          next: 'branch',
        },
        {
          id: 'branch',
          type: 'condition',
          expression: "intent === 'urgent'",
          on_true: 'transfer',
          on_false: 'end',
        },
        { id: 'transfer', type: 'transfer', target_phone: '+14155550123' },
        { id: 'end', type: 'end', label: 'End' },
      ],
    });
  });

  it('rebuilds connections from edges instead of stale visual node data', () => {
    const staleVisualConnection = convertReactFlowToAgentFlow(
      [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { next: 'old-branch' } },
        {
          id: 'branch',
          type: 'condition',
          position: { x: 0, y: 140 },
          data: {
            expression: 'needs_handoff',
            on_true: 'old-transfer',
            on_false: 'old-end',
          },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 280 }, data: {} },
      ],
      [
        { id: 'e-start-branch', source: 'start', target: 'branch' },
        { id: 'e-branch-true-end', source: 'branch', target: 'end', sourceHandle: 'true' },
      ],
    );

    expect(staleVisualConnection.nodes[0]).toStrictEqual({
      id: 'start',
      type: 'start',
      next: 'branch',
    });
    expect(staleVisualConnection.nodes[1]).toStrictEqual({
      id: 'branch',
      type: 'condition',
      expression: 'needs_handoff',
      on_true: 'end',
      on_false: '',
    });
  });
});

describe('validateAgentFlow', () => {
  it('flags condition branches that point to missing nodes', () => {
    expect(
      validateAgentFlow({
        start_node_id: 'start',
        nodes: [
          { id: 'start', type: 'start', next: 'branch' },
          {
            id: 'branch',
            type: 'condition',
            expression: 'needs_handoff',
            on_true: 'end',
            on_false: 'missing',
          },
          { id: 'end', type: 'end' },
        ],
      }),
    ).toStrictEqual(['Condition node "branch" false branch points to missing node "missing".']);
  });
});
