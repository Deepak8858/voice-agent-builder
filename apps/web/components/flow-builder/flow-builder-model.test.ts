import assert from 'node:assert/strict';
import type { Node } from '@xyflow/react';
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

const updated = updateNodeData(nodes, 'ask', { question: 'New question' });

assert.equal(nodes[1].data.question, 'Old question');
assert.equal(updated[1].data.question, 'New question');
assert.equal(getSelectedNode(updated, 'ask')?.data.question, 'New question');
assert.equal(getSelectedNode(updated, null), null);
assert.deepEqual(buildNodeData('send_message'), { channel: 'sms', body: '' });
assert.deepEqual(createFlowNode('tool_call', { x: 12, y: 34 }).data, { tool_name: '' });

const defaultFlow = buildDefaultAgentFlow({
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
});

assert.equal(defaultFlow.start_node_id, 'start');
assert.deepEqual(
  defaultFlow.nodes.map((node) => node.type),
  ['start', 'speak', 'ask_question', 'ask_question', 'tool_call', 'end'],
);
assert.equal(defaultFlow.nodes[0].next, 'greeting');
assert.equal((defaultFlow.nodes[4] as { tool_name?: string }).tool_name, 'google_calendar_booking');
assert.deepEqual(validateAgentFlow(defaultFlow), []);

const converted = convertAgentFlowToReactFlow({
  start_node_id: 'start',
  nodes: [
    { id: 'start', type: 'start', next: 'msg' },
    { id: 'msg', type: 'send_message', body: 'Text body', channel: 'sms', next: 'end' },
    { id: 'end', type: 'end' },
  ],
});

assert.deepEqual(
  converted.nodes.map((node) => node.position),
  [
    { x: 120, y: 40 },
    { x: 120, y: 200 },
    { x: 120, y: 360 },
  ],
);
assert.equal(converted.nodes[1].type, 'send_message');
assert.equal(converted.nodes[1].data.body, 'Text body');
assert.equal(converted.nodes[0].data.next, undefined);
assert.deepEqual(
  converted.edges.map(({ source, target }) => ({ source, target })),
  [
    { source: 'start', target: 'msg' },
    { source: 'msg', target: 'end' },
  ],
);

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

assert.deepEqual(canonical, {
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

assert.deepEqual(staleVisualConnection.nodes[0], {
  id: 'start',
  type: 'start',
  next: 'branch',
});
assert.deepEqual(staleVisualConnection.nodes[1], {
  id: 'branch',
  type: 'condition',
  expression: 'needs_handoff',
  on_true: 'end',
  on_false: '',
});

assert.deepEqual(
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
  ['Condition node "branch" false branch points to missing node "missing".'],
);
