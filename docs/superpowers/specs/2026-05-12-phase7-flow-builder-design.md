# Phase 7.1 — Visual Flow Builder Serialization

## Context

React Flow canvas exists (`apps/web/components/flow-builder/`) with node types wired (start, speak, ask_question, condition, tool_call, transfer, end). Three gaps:

1. `onSave` callback fires but no API call
2. No flow→AgentSpec serialization
3. Condition nodes emit `true`/`false` handles but edge data doesn't store branch

## Design

**Approach: Flow + Spec Hybrid**

Existing form fields (`identity`, `voice`, `goals`, `first_message`, `compliance`) stay as-is. Flow defines only `conversation_flow` branching logic. When flow is empty, LLM generates from spec fields.

### API Changes

**Endpoint:** `PUT /workspaces/:workspaceId/agents/:agentId/flow`

**Request:**
```ts
interface SaveFlowRequest {
  flow: {
    nodes: Array<{
      id: string;
      type: 'start' | 'speak' | 'ask_question' | 'condition' | 'tool_call' | 'transfer' | 'end';
      data: Record<string, unknown>;
      position: { x: number; y: number };
    }>;
    edges: Array<{
      id: string;
      source: string;
      target: string;
      sourceHandle?: string | null; // 'true' | 'false' | null (for condition branches)
    }>;
  } | null; // null = no flow, use legacy spec fields
}
```

**Response:** `{ success: true, flow_node_count: number }`

**Validation:**
- Must have at least one `start` and one `end` node
- All non-end nodes must have at least one outgoing edge
- `start` node must have exactly one outgoing edge
- Every `condition` node's outgoing edges must include both `true` and `false` branches
- No orphan nodes (all nodes reachable from `start`)

### Serialization

**Flow → AgentSpec** (when saving):

```ts
function flowToAgentSpec(flow: SaveFlowRequest['flow'], baseSpec: Partial<AgentSpec>): AgentSpec {
  if (!flow) return { ...baseSpec, flow: undefined };

  const nodeMap = new Map(flow.nodes.map(n => [n.id, n]));
  const adjacency = buildAdjacency(flow.edges);

  // Topological sort from start
  const sorted = topologicalSort(nodeMap, adjacency);
  const conversationFlow = sorted.map(id => nodeMap.get(id)!);

  return {
    ...baseSpec,
    flow: {
      nodes: conversationFlow.map(n => ({
        id: n.id,
        type: n.type,
        ...extractNodeFields(n), // type-specific fields
        next: adjacency.get(n.id)?.[0] ?? undefined, // default next (override below)
      })),
      start_node_id: flow.nodes.find(n => n.type === 'start')?.id!,
    },
  };
}
```

**Condition edges get branch data:**

```ts
// On edge creation from condition node
const isConditionEdge = sourceNode.type === 'condition';
if (isConditionEdge) {
  setEdges(eds => addEdge({
    ...params,
    data: { branch: params.sourceHandle ?? 'true' }, // 'true' | 'false'
    animated: true,
  }, eds));
}
```

Then serialization reads `edge.data?.branch` to set `on_true`/`on_false` on the condition node.

### AgentSpec flow field structure

From `packages/shared/src/schemas/agent-spec.ts`:

```ts
FlowNodeSchema.discriminatedUnion([
  BaseNode.extend({ type: z.literal('start') }),
  BaseNode.extend({ type: z.literal('speak'), text: z.string() }),
  BaseNode.extend({
    type: z.literal('ask_question'),
    question: z.string(),
    capture_field: z.string().optional(),
  }),
  BaseNode.extend({
    type: z.literal('condition'),
    expression: z.string(),
    on_true: z.string(),  // node ID
    on_false: z.string(),  // node ID
  }),
  BaseNode.extend({
    type: z.literal('tool_call'),
    tool_name: z.string(),
    arguments: z.record(z.string(), z.any()).optional(),
  }),
  BaseNode.extend({ type: z.literal('transfer'), target_phone: z.string().optional() }),
  BaseNode.extend({ type: z.literal('send_message'), ... }),
  BaseNode.extend({ type: z.literal('end') }),
  BaseNode.extend({ type: z.literal('fallback'), message: z.string().optional() }),
]);
```

### Files to create/modify

| File | Change |
|---|---|
| `apps/web/components/flow-builder/flow-builder-client.tsx` | Wire `onSave` to API, store conditional edge data |
| `apps/web/lib/api.ts` | Add `saveAgentFlow(workspaceId, agentId, flow)` |
| `apps/api/src/agents/agents.controller.ts` | Add `PUT /:workspaceId/agents/:agentId/flow` |
| `apps/api/src/agents/agents.service.ts` | Add `saveFlow()` with validation |
| `packages/shared/src/schemas/agent-spec.ts` | Add `condition_node.branch` edge field |

### Validation on save

```ts
async saveFlow(workspaceId: string, agentId: string, flow: SaveFlowRequest['flow']) {
  if (!flow) return; // clear flow

  const nodes = new Map(flow.nodes.map(n => [n.id, n]));
  const startNodes = [...nodes.values()].filter(n => n.type === 'start');
  const endNodes = [...nodes.values()].filter(n => n.type === 'end');

  if (startNodes.length !== 1) throw new BadRequestException('Must have exactly one start node');
  if (endNodes.length < 1) throw new BadRequestException('Must have at least one end node');

  // Check all condition nodes have both true/false edges
  for (const node of nodes.values()) {
    if (node.type === 'condition') {
      const outEdges = flow.edges.filter(e => e.source === node.id);
      const hasTrue = outEdges.some(e => e.data?.branch === 'true');
      const hasFalse = outEdges.some(e => e.data?.branch === 'false');
      if (!hasTrue || !hasFalse) throw new BadRequestException(`Condition ${node.id} missing true/false branch`);
    }
  }

  // BFS from start — all nodes reachable
  const reachable = bfs(flow.nodes.find(n => n.type === 'start')!.id, flow.edges);
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) throw new BadRequestException(`Orphan node: ${node.id}`);
  }
}
```

## Out of scope

- Visual improvements to node rendering (Phase 1-3)
- Flow execution engine (Phase 4 own voice runtime)
- Import/export flows as shareable templates (Phase 6)