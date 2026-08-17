import dagre from '@dagrejs/dagre';
import type { Edge, Node, XYPosition } from '@xyflow/react';
import type { AgentSpec } from '@voiceforge/shared';

const NODE_X = 120;
const NODE_Y_START = 40;
const NODE_Y_GAP = 160;

/** Fallback node dimensions used when React Flow has not measured a node yet. */
export const LAYOUT_NODE_WIDTH = 230;
export const LAYOUT_NODE_HEIGHT = 100;
const LAYOUT_NODE_SEPARATION = 60;
const LAYOUT_RANK_SEPARATION = 70;

export type AgentFlow = NonNullable<AgentSpec['flow']>;

export function buildDefaultAgentFlow(spec: AgentSpec): AgentFlow {
  const usedIds = new Set<string>();
  const nodes: AgentFlow['nodes'] = [
    { id: uniqueNodeId('start', usedIds), type: 'start', label: 'Start' },
  ];

  const appendNode = (node: AgentFlow['nodes'][number]) => {
    const previous = nodes[nodes.length - 1];
    if (previous && previous.type !== 'end') {
      previous.next = node.id;
    }
    nodes.push(node);
  };

  if (spec.conversation_rules.first_message) {
    appendNode({
      id: uniqueNodeId('greeting', usedIds),
      type: 'speak',
      label: 'Greeting',
      text: spec.conversation_rules.first_message,
    });
  }

  for (const field of spec.required_fields) {
    appendNode({
      id: uniqueNodeId(`ask-${field.key}`, usedIds),
      type: 'ask_question',
      label: field.description ?? `Capture ${field.key}`,
      question: field.description ?? `Please provide ${humanizeField(field.key)}.`,
      capture_field: field.key,
    });
  }

  for (const tool of spec.tools) {
    appendNode({
      id: uniqueNodeId(`tool-${tool.name}`, usedIds),
      type: 'tool_call',
      label: tool.name,
      tool_name: tool.name,
    });
  }

  appendNode({ id: uniqueNodeId('end', usedIds), type: 'end', label: 'End' });

  return {
    start_node_id: 'start',
    nodes,
  };
}

export function buildNodeData(type: string): Record<string, unknown> {
  switch (type) {
    case 'speak':
      return { text: 'Say something...' };
    case 'ask_question':
      return { question: 'Ask...', capture_field: '' };
    case 'condition':
      return { expression: '' };
    case 'knowledge_lookup':
      return { query_field: '' };
    case 'tool_call':
      return { tool_name: '' };
    case 'transfer':
      return { target_phone: '' };
    case 'send_message':
      return { channel: 'sms', body: '' };
    case 'fallback':
      return { message: '' };
    default:
      return {};
  }
}

export function createFlowNode(
  type: string,
  position: XYPosition,
  id = `${type}-${Date.now()}`,
): Node {
  return {
    id,
    type,
    position,
    data: buildNodeData(type),
  };
}

/**
 * Lays the graph out top-to-bottom with dagre. Returns new node objects with
 * updated positions; edges are unchanged.
 */
export function autoLayoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: 'TB',
    nodesep: LAYOUT_NODE_SEPARATION,
    ranksep: LAYOUT_RANK_SEPARATION,
  });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.measured?.width ?? LAYOUT_NODE_WIDTH,
      height: node.measured?.height ?? LAYOUT_NODE_HEIGHT,
    });
  }
  for (const edge of edges) {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      graph.setEdge(edge.source, edge.target, {}, edge.id);
    }
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const laidOut = graph.node(node.id);
    if (!laidOut) return node;
    const width = node.measured?.width ?? LAYOUT_NODE_WIDTH;
    const height = node.measured?.height ?? LAYOUT_NODE_HEIGHT;
    // dagre positions are node centers; React Flow uses top-left corners.
    return {
      ...node,
      position: { x: laidOut.x - width / 2, y: laidOut.y - height / 2 },
    };
  });
}

/**
 * True when any two nodes' estimated bounding boxes intersect. Used to detect
 * AI-generated flows that render as an overlapping vertical stack so the
 * builder can auto-tidy them on load.
 */
export function nodesOverlap(nodes: Node[]): boolean {
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    if (!a) continue;
    const aWidth = a.measured?.width ?? LAYOUT_NODE_WIDTH;
    const aHeight = a.measured?.height ?? LAYOUT_NODE_HEIGHT;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      if (!b) continue;
      const bWidth = b.measured?.width ?? LAYOUT_NODE_WIDTH;
      const bHeight = b.measured?.height ?? LAYOUT_NODE_HEIGHT;
      const separated =
        a.position.x + aWidth <= b.position.x ||
        b.position.x + bWidth <= a.position.x ||
        a.position.y + aHeight <= b.position.y ||
        b.position.y + bHeight <= a.position.y;
      if (!separated) return true;
    }
  }
  return false;
}

/**
 * Client-side per-node configuration checks (UX only — the server-side flow
 * validation remains the authority via the PUT /flow endpoint).
 */
export interface NodeConfigIssue {
  field: string;
  message: string;
}

export function validateNodeConfig(node: Node): NodeConfigIssue[] {
  const data = asRecord(node.data);
  const issues: NodeConfigIssue[] = [];
  const type = normalizeVisualNodeType(node.type ?? '');

  switch (type) {
    case 'speak':
      if (!hasText(data['text'])) {
        issues.push({ field: 'text', message: 'Add the text the agent should speak.' });
      }
      break;
    case 'ask_question':
      if (!hasText(data['question'])) {
        issues.push({ field: 'question', message: 'Add the question the agent should ask.' });
      }
      if (!hasText(data['capture_field'])) {
        issues.push({
          field: 'capture_field',
          message: 'Set a capture field so the answer is stored.',
        });
      }
      break;
    case 'condition':
      if (!hasText(data['expression'])) {
        issues.push({ field: 'expression', message: 'Add a condition expression.' });
      }
      break;
    case 'tool_call':
      if (!hasText(data['tool_name'])) {
        issues.push({ field: 'tool_name', message: 'Choose the tool to call.' });
      }
      break;
    case 'send_message': {
      const channel = data['channel'];
      if (channel !== 'sms' && channel !== 'email') {
        issues.push({ field: 'channel', message: 'Channel must be sms or email.' });
      }
      if (!hasText(data['body'])) {
        issues.push({ field: 'body', message: 'Add the message body to send.' });
      }
      break;
    }
    case 'transfer': {
      const phone = data['target_phone'];
      if (typeof phone === 'string' && phone.trim().length > 0 && !isPhoneLike(phone)) {
        issues.push({
          field: 'target_phone',
          message: 'Transfer number should look like a phone number, e.g. +14155551212.',
        });
      }
      break;
    }
    default:
      break;
  }

  return issues;
}

/** Aggregates graph-level and per-node issues for the whole canvas. */
export function collectFlowIssues(nodes: Node[], edges: Edge[]): string[] {
  const flow = convertReactFlowToAgentFlow(nodes, edges);
  const issues = [...validateAgentFlow(flow)];
  for (const node of nodes) {
    for (const issue of validateNodeConfig(node)) {
      issues.push(`${nodeDisplayName(node)}: ${issue.message}`);
    }
  }
  return issues;
}

/** Creates a copy of a node with a fresh id and a slight position offset. */
export function duplicateFlowNode(node: Node, id = freshNodeId(node.type ?? 'node')): Node {
  return {
    ...node,
    id,
    position: { x: node.position.x + 48, y: node.position.y + 48 },
    data: { ...asRecord(node.data) },
    selected: false,
  };
}

export function freshNodeId(type: string): string {
  return `${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nodeDisplayName(node: Node): string {
  const label = optionalString(asRecord(node.data)['label']);
  const type = (node.type ?? 'node').replace(/_/g, ' ');
  return label ? `${label} (${type})` : `${type} "${node.id}"`;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPhoneLike(value: string): boolean {
  return /^\+?[0-9\s().-]{7,20}$/.test(value.trim());
}

export function updateNodeData(
  nodes: Node[],
  nodeId: string,
  data: Record<string, unknown>,
): Node[] {
  return nodes.map((node) =>
    node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node,
  );
}

export function getSelectedNode(nodes: Node[], selectedNodeId: string | null): Node | null {
  if (!selectedNodeId) return null;
  return nodes.find((node) => node.id === selectedNodeId) ?? null;
}

export function convertAgentFlowToReactFlow(flow: AgentFlow): { nodes: Node[]; edges: Edge[] } {
  const nodeMap = new Map<string, Node>();
  const edges: Edge[] = [];

  flow.nodes.forEach((node, index) => {
    nodeMap.set(node.id, {
      id: node.id,
      type: normalizeVisualNodeType(node.type),
      position: { x: NODE_X, y: NODE_Y_START + index * NODE_Y_GAP },
      data: {
        label: node.type === 'start' ? 'Start' : node.type === 'end' ? 'End' : '',
        ...Object.fromEntries(
          Object.entries(node).filter(
            ([key]) => !['id', 'type', 'next', 'on_true', 'on_false'].includes(key),
          ),
        ),
      },
    });
  });

  for (const node of flow.nodes) {
    if (node.next && nodeMap.has(node.next)) {
      edges.push({
        id: `e-${node.id}-${node.next}`,
        source: node.id,
        target: node.next,
        animated: true,
      });
    }
    if (node.type === 'condition') {
      if (node.on_true && nodeMap.has(node.on_true)) {
        edges.push({
          id: `e-${node.id}-true-${node.on_true}`,
          source: node.id,
          target: node.on_true,
          sourceHandle: 'true',
          animated: true,
        });
      }
      if (node.on_false && nodeMap.has(node.on_false)) {
        edges.push({
          id: `e-${node.id}-false-${node.on_false}`,
          source: node.id,
          target: node.on_false,
          sourceHandle: 'false',
          animated: true,
        });
      }
    }
  }

  return { nodes: [...nodeMap.values()], edges };
}

export function convertReactFlowToAgentFlow(nodes: Node[], edges: Edge[]): AgentFlow {
  const outgoing = new Map<string, Edge[]>();
  for (const edge of edges) {
    const existing = outgoing.get(edge.source) ?? [];
    existing.push(edge);
    outgoing.set(edge.source, existing);
  }

  const flowNodes = nodes.map((node) => toAgentFlowNode(node, outgoing));
  return {
    start_node_id: flowNodes.find((node) => node.type === 'start')?.id ?? flowNodes[0]?.id ?? '',
    nodes: flowNodes,
  };
}

export function validateAgentFlow(flow: AgentFlow): string[] {
  const issues: string[] = [];
  const ids = new Set(flow.nodes.map((node) => node.id));

  if (flow.nodes.length < 2) {
    issues.push('Flow must include at least two nodes.');
  }
  if (!ids.has(flow.start_node_id)) {
    issues.push(`Start node "${flow.start_node_id}" is missing from the flow.`);
  }
  if (!flow.nodes.some((node) => node.type === 'end')) {
    issues.push('Flow must include an end node.');
  }

  for (const node of flow.nodes) {
    collectTargetIssue(issues, ids, node.id, node.next, 'next');
    if (node.type === 'condition') {
      collectTargetIssue(issues, ids, node.id, node.on_true, 'true branch');
      collectTargetIssue(issues, ids, node.id, node.on_false, 'false branch');
    }
  }

  return issues;
}

function toAgentFlowNode(node: Node, outgoing: Map<string, Edge[]>): AgentFlow['nodes'][number] {
  const data = asRecord(node.data);
  const label = optionalString(data['label']);
  const next = nextTarget(node.id, outgoing);
  const base = {
    id: node.id,
    ...(label ? { label } : {}),
  };

  switch (normalizeVisualNodeType(node.type ?? 'end')) {
    case 'start':
      return { ...base, type: 'start', ...(next ? { next } : {}) };
    case 'speak':
      return {
        ...base,
        type: 'speak',
        text: stringValue(data['text']),
        ...(next ? { next } : {}),
      };
    case 'ask_question':
      return {
        ...base,
        type: 'ask_question',
        question: stringValue(data['question']),
        ...(optionalString(data['capture_field'])
          ? { capture_field: optionalString(data['capture_field']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'condition':
      return {
        ...base,
        type: 'condition',
        expression: stringValue(data['expression']),
        on_true: branchTarget(node.id, outgoing, 'true') ?? '',
        on_false: branchTarget(node.id, outgoing, 'false') ?? '',
      };
    case 'knowledge_lookup':
      return {
        ...base,
        type: 'knowledge_lookup',
        ...(optionalString(data['query_field'])
          ? { query_field: optionalString(data['query_field']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'tool_call':
      return {
        ...base,
        type: 'tool_call',
        tool_name: stringValue(data['tool_name']),
        ...(asRecordOrNull(data['arguments']) ? { arguments: asRecord(data['arguments']) } : {}),
        ...(next ? { next } : {}),
      };
    case 'transfer':
      return {
        ...base,
        type: 'transfer',
        ...(optionalString(data['target_phone'])
          ? { target_phone: optionalString(data['target_phone']) }
          : {}),
        ...(next ? { next } : {}),
      };
    case 'send_message':
      return {
        ...base,
        type: 'send_message',
        channel: data['channel'] === 'email' ? 'email' : 'sms',
        body: stringValue(data['body']),
        ...(next ? { next } : {}),
      };
    case 'fallback':
      return {
        ...base,
        type: 'fallback',
        ...(optionalString(data['message']) ? { message: optionalString(data['message']) } : {}),
        ...(next ? { next } : {}),
      };
    case 'end':
    default:
      return { ...base, type: 'end' };
  }
}

function normalizeVisualNodeType(type: string): string {
  if (type === 'ask-question') return 'ask_question';
  if (type === 'tool-call') return 'tool_call';
  return type;
}

function nextTarget(nodeId: string, outgoing: Map<string, Edge[]>): string | undefined {
  const edges = outgoing.get(nodeId) ?? [];
  const edge = edges.find((candidate) => !isConditionHandle(candidate.sourceHandle)) ?? edges[0];
  return edge?.target;
}

function branchTarget(
  nodeId: string,
  outgoing: Map<string, Edge[]>,
  branch: 'true' | 'false',
): string | undefined {
  return (outgoing.get(nodeId) ?? []).find((edge) => edge.sourceHandle === branch)?.target;
}

function isConditionHandle(handle: string | null | undefined): boolean {
  return handle === 'true' || handle === 'false';
}

function collectTargetIssue(
  issues: string[],
  ids: Set<string>,
  nodeId: string,
  target: string | undefined,
  label: string,
): void {
  if (target === undefined) return;
  if (target.trim().length === 0) {
    issues.push(`Node "${nodeId}" ${label} target is empty.`);
    return;
  }
  if (!ids.has(target)) {
    const prefix = label.includes('branch') ? 'Condition node' : 'Node';
    issues.push(`${prefix} "${nodeId}" ${label} points to missing node "${target}".`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrNull(value) ?? {};
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function uniqueNodeId(raw: string, used: Set<string>): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node';
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function humanizeField(value: string): string {
  return value.replace(/_/g, ' ');
}
