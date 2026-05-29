import assert from 'node:assert/strict';
import type { Node } from '@xyflow/react';
import {
  buildNodeData,
  convertAgentFlowToReactFlow,
  createFlowNode,
  getSelectedNode,
  updateNodeData,
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
assert.deepEqual(
  converted.edges.map(({ source, target }) => ({ source, target })),
  [
    { source: 'start', target: 'msg' },
    { source: 'msg', target: 'end' },
  ],
);
