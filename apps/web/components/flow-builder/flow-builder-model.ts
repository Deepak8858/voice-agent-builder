import type { Edge, Node, XYPosition } from '@xyflow/react';

const NODE_X = 120;
const NODE_Y_START = 40;
const NODE_Y_GAP = 160;

type AgentFlowNode = {
  id: string;
  type: string;
  next?: string;
  on_true?: string;
  on_false?: string;
  [key: string]: unknown;
};

type AgentFlow = {
  start_node_id?: string;
  nodes: AgentFlowNode[];
};

export function buildNodeData(type: string): Record<string, unknown> {
  switch (type) {
    case 'speak':
      return { text: 'Say something...' };
    case 'ask_question':
      return { question: 'Ask...', capture_field: '' };
    case 'condition':
      return { expression: '', on_true: '', on_false: '' };
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
        ...Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'id' && key !== 'type')),
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

  return { nodes: [...nodeMap.values()], edges };
}

function normalizeVisualNodeType(type: string): string {
  if (type === 'ask-question') return 'ask_question';
  if (type === 'tool-call') return 'tool_call';
  return type;
}
