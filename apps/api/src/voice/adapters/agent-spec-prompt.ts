import type { AgentSpec, FlowNode } from '@voiceforge/shared';

export function formatFlowInstructions(spec: AgentSpec): string[] {
  const nodes = spec.flow?.nodes ?? [];
  if (nodes.length === 0) return [];

  return [
    'Conversation flow: follow these visual builder steps in order unless the caller response requires a conditional branch.',
    ...nodes.map((node) => `- ${formatNode(node)}`),
  ];
}

function formatNode(node: FlowNode): string {
  const label = node.label ? ` (${node.label})` : '';
  const next = node.next ? ` Next: ${node.next}.` : '';
  switch (node.type) {
    case 'start':
      return `${node.id}${label}: start.${next}`;
    case 'speak':
      return `${node.id}${label}: say "${clip(node.text)}".${next}`;
    case 'ask_question':
      return `${node.id}${label}: ask "${clip(node.question)}"${node.capture_field ? ` and capture ${node.capture_field}` : ''}.${next}`;
    case 'condition':
      return `${node.id}${label}: if ${node.expression}, go to ${node.on_true}; otherwise go to ${node.on_false}.`;
    case 'knowledge_lookup':
      return `${node.id}${label}: look up knowledge${node.query_field ? ` using ${node.query_field}` : ''}.${next}`;
    case 'tool_call':
      return `${node.id}${label}: call tool ${node.tool_name}.${next}`;
    case 'transfer':
      return `${node.id}${label}: transfer${node.target_phone ? ` to ${node.target_phone}` : ''}.${next}`;
    case 'send_message':
      return `${node.id}${label}: send ${node.channel} message "${clip(node.body)}".${next}`;
    case 'fallback':
      return `${node.id}${label}: fallback${node.message ? ` with "${clip(node.message)}"` : ''}.${next}`;
    case 'end':
      return `${node.id}${label}: end the call.`;
  }
}

function clip(value: string, max = 180): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
