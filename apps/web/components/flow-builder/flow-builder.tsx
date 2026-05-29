'use client';

import { useCallback, useState } from 'react';
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NODE_TYPES } from './node-palette';
import { NodePalette } from './node-palette';
import { NodeConfigPanel } from './node-config-panel';
import { createFlowNode, getSelectedNode, updateNodeData } from './flow-builder-model';

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

interface FlowBuilderProps {
  workspaceId?: string;
  agentId?: string;
  initialNodes?: Node[];
  initialEdges?: Edge[];
  isSaving?: boolean;
  onSave?: (nodes: Node[], edges: Edge[]) => void;
}

export function FlowBuilder(props: FlowBuilderProps) {
  return (
    <ReactFlowProvider>
      <FlowBuilderCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowBuilderCanvas({ initialNodes, initialEdges, isSaving = false, onSave }: FlowBuilderProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes ?? INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState((initialEdges ?? []) as Edge[]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { screenToFlowPosition } = useReactFlow();
  const selectedNode = getSelectedNode(nodes as Node[], selectedNodeId);

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
      const id = `${type}-${Date.now()}`;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const newNode = createFlowNode(type, position, id);
      setNodes((nds) => [...nds, newNode]);
      setSelectedNodeId(id);
    },
    [screenToFlowPosition, setNodes],
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const onDragStart = useCallback((event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleSave = useCallback(() => {
    onSave?.(nodes as Node[], edges as Edge[]);
  }, [nodes, edges, onSave]);

  const handleConfigChange = useCallback((nodeId: string, data: Record<string, unknown>) => {
    setNodes((nds) => updateNodeData(nds as Node[], nodeId, data));
  }, [setNodes]);

  return (
    <div className="flex h-full gap-0 rounded-xl border border-border overflow-hidden">
      <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-border bg-sidebar">
        <NodePalette onDragStart={onDragStart} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-muted/30">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-background/80 px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {nodes.length} nodes / {edges.length} connections
          </p>
          <Button size="sm" onClick={handleSave} disabled={isSaving} className="gap-1.5">
            {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save flow
          </Button>
        </div>
        <div className="min-h-0 flex-1">
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
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      <div className="w-72 flex-shrink-0 overflow-y-auto border-l border-border bg-sidebar">
        <NodeConfigPanel
          node={selectedNode}
          onChange={handleConfigChange}
          onSave={handleSave}
          isSaving={isSaving}
        />
      </div>
    </div>
  );
}
