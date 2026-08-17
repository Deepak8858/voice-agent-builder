import type { Edge, Node } from '@xyflow/react';
import { getNodeMeta } from './nodes/node-meta';

interface FlowPreviewProps {
  flow?: { nodes: Node[]; edges: Edge[] };
  /** Maximum steps rendered before collapsing into a "+N more" row. */
  limit?: number;
}

/**
 * Compact, read-only summary of the conversation flow for the builder page.
 * All node content comes from the (possibly AI-generated) spec and is rendered
 * as plain text.
 */
export function FlowPreview({ flow, limit = 6 }: FlowPreviewProps) {
  const nodes = flow?.nodes ?? [];

  if (nodes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
        No conversation flow yet. Open the flow builder to create one.
      </p>
    );
  }

  const ordered = orderNodes(nodes, flow?.edges ?? []);
  const visible = ordered.slice(0, limit);
  const remaining = ordered.length - visible.length;

  return (
    /* ph-no-capture: previews include spoken scripts and transfer numbers. */
    <ol className="ph-no-capture flex flex-col gap-1.5">
      {visible.map((node) => {
        const meta = getNodeMeta(node.type);
        return (
          <li
            key={node.id}
            className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3 py-2"
          >
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.palette}`}>
              <meta.icon className="h-3.5 w-3.5" aria-hidden />
            </span>
            <span className="w-24 shrink-0 truncate text-xs font-medium text-foreground">
              {meta.label}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {previewText(node)}
            </span>
          </li>
        );
      })}
      {remaining > 0 ? (
        <li className="px-3 py-1 text-xs text-muted-foreground">+{remaining} more steps</li>
      ) : null}
    </ol>
  );
}

/** Walks the graph from the start node so the preview matches call order. */
function orderNodes(nodes: Node[], edges: Edge[]): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nextOf = new Map<string, string>();
  for (const edge of edges) {
    if (!nextOf.has(edge.source)) nextOf.set(edge.source, edge.target);
  }

  const start = nodes.find((node) => node.type === 'start') ?? nodes[0];
  if (!start) return nodes;

  const ordered: Node[] = [];
  const seen = new Set<string>();
  let current: Node | undefined = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ordered.push(current);
    const nextId = nextOf.get(current.id);
    current = nextId ? byId.get(nextId) : undefined;
  }

  for (const node of nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

function previewText(node: Node): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  for (const key of ['text', 'question', 'expression', 'tool_name', 'body', 'message', 'target_phone', 'query_field']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return '—';
}
