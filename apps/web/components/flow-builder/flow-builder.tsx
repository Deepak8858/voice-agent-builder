'use client';

import { useCallback, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { NODE_TYPES } from './node-palette';
import { NodePalette } from './node-palette';
import { NodeConfigPanel } from './node-config-panel';

const INITIAL_NODES: Node[] = [
  {
    id: 'start-1',
    type: 'start',
    position: { x: 250, y: 50 },
    data: { label: 'Start' },
  },
  {
    id: 'end-1',
    type: 'end',
    position: { x: 250, y: 400 },
    data: { label: 'End' },
  },
];

function buildNodeData(type: string): Record<string, unknown> {
  switch (type) {
    case 'speak': return { text: 'Say something...' };
    case 'ask_question': return { question: 'Ask...', capture_field: '' };
    case 'condition': return { expression: '', on_true: '', on_false: '' };
    case 'tool_call': return { tool_name: '' };
    case 'transfer': return { target_phone: '' };
    default: return {};
  }
}

interface FlowBuilderProps {
  workspaceId?: string;
  agentId?: string;
  initialNodes?: Node[];
  initialEdges?: Edge[];
  onSave?: (nodes: Node[], edges: Edge[]) => void;
}

export function FlowBuilder({ initialNodes, initialEdges, onSave }: FlowBuilderProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes ?? INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState((initialEdges ?? []) as Edge[]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);

  const onConnect: OnConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, animated: true }, eds)),
    [setEdges],
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;
      const reactFlowBounds = event.currentTarget.getBoundingClientRect();
      const position = {
        x: event.clientX - reactFlowBounds.left - 100,
        y: event.clientY - reactFlowBounds.top - 30,
      };
      const id = `${type}-${Date.now()}`;
      const newNode: Node = {
        id,
        type,
        position,
        data: buildNodeData(type),
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  const onDragStart = useCallback((event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleSave = useCallback(() => {
    onSave?.(nodes, edges as Edge[]);
  }, [nodes, edges, onSave]);

  const handleConfigChange = useCallback((nodeId: string, data: Record<string, unknown>) => {
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n)),
    );
  }, [setNodes]);

  return (
    <div className="flex h-full gap-0">
      {/* Left: Node palette */}
      <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-zinc-200 dark:border-zinc-800">
        <NodePalette onDragStart={onDragStart} />
      </div>

      {/* Center: Canvas */}
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={(changes) => {
            onNodesChange(changes as Parameters<typeof onNodesChange>[0]);
          }}
          onEdgesChange={(changes) => {
            onEdgesChange(changes as Parameters<typeof onEdgesChange>[0]);
          }}
          onConnect={onConnect}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={NODE_TYPES}
          fitView
          className="bg-zinc-50 dark:bg-zinc-950"
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {/* Right: Config panel */}
      <div className="w-72 flex-shrink-0 overflow-y-auto border-l border-zinc-200 dark:border-zinc-800">
        <NodeConfigPanel
          node={selectedNode}
          onChange={handleConfigChange}
          onSave={handleSave}
        />
      </div>
    </div>
  );
}
