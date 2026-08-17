'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
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
import type { ToolSummary } from '@voiceforge/shared';
import '@xyflow/react/dist/style.css';
import { Redo2, Undo2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NODE_TYPES, NodePalette } from './node-palette';
import { NodeConfigPanel } from './node-config-panel';
import { FlowTopBar } from './flow-top-bar';
import {
  LAYOUT_NODE_HEIGHT,
  autoLayoutNodes,
  collectFlowIssues,
  createFlowNode,
  duplicateFlowNode,
  freshNodeId,
  getSelectedNode,
  nodesOverlap,
  updateNodeData,
} from './flow-builder-model';

const INITIAL_NODES: Node[] = [
  { id: 'start-1', type: 'start', position: { x: 250, y: 40 }, data: { label: 'Start' } },
  { id: 'end-1', type: 'end', position: { x: 250, y: 400 }, data: { label: 'End' } },
];

/** Snapshot of the editable graph used for history and dirty tracking. */
interface FlowSnapshot {
  nodes: Node[];
  edges: Edge[];
}

/** Configuration for the full-screen top bar rendered above the canvas. */
export interface FlowTopBarConfig {
  agentName?: string;
  backHref: string;
  onNavigateAway: (event: React.MouseEvent) => void;
}

interface FlowBuilderProps {
  initialNodes?: Node[];
  initialEdges?: Edge[];
  availableTools?: ToolSummary[];
  isSaving?: boolean;
  onSave?: (nodes: Node[], edges: Edge[]) => void;
  /** Bumped by the parent after a successful save so the graph is marked clean. */
  savedSignal?: number;
  onDirtyChange?: (isDirty: boolean) => void;
  topBar?: FlowTopBarConfig;
}

export function FlowBuilder(props: FlowBuilderProps) {
  return (
    <ReactFlowProvider>
      <FlowBuilderCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowBuilderCanvas({
  initialNodes,
  initialEdges,
  availableTools = [],
  isSaving = false,
  onSave,
  savedSignal = 0,
  onDirtyChange,
  topBar,
}: FlowBuilderProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes ?? INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState((initialEdges ?? []) as Edge[]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [past, setPast] = useState<FlowSnapshot[]>([]);
  const [future, setFuture] = useState<FlowSnapshot[]>([]);
  const [baseline, setBaseline] = useState(() =>
    serializeFlow(initialNodes ?? INITIAL_NODES, (initialEdges ?? []) as Edge[]),
  );

  const { screenToFlowPosition, fitView } = useReactFlow();
  const nodesRef = useRef(nodes as Node[]);
  const edgesRef = useRef(edges as Edge[]);
  const pastRef = useRef(past);
  const futureRef = useRef(future);
  const pendingSaveRef = useRef<string | null>(null);
  const dragSnapshotRef = useRef<FlowSnapshot | null>(null);
  const configEditKeyRef = useRef<string | null>(null);
  const configEditTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    nodesRef.current = nodes as Node[];
    edgesRef.current = edges as Edge[];
  }, [nodes, edges]);

  const selectedNode = getSelectedNode(nodes as Node[], selectedNodeId);
  const issues = useMemo(() => collectFlowIssues(nodes as Node[], edges as Edge[]), [nodes, edges]);
  const isDirty = serializeFlow(nodes as Node[], edges as Edge[]) !== baseline;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  /** After a successful save, the submitted graph becomes the clean baseline. */
  useEffect(() => {
    if (savedSignal > 0 && pendingSaveRef.current) {
      setBaseline(pendingSaveRef.current);
      pendingSaveRef.current = null;
    }
  }, [savedSignal]);

  const pushHistory = useCallback((snapshot?: FlowSnapshot) => {
    const previous = snapshot ?? { nodes: nodesRef.current, edges: edgesRef.current };
    const nextPast = [...pastRef.current.slice(-49), previous];
    pastRef.current = nextPast;
    futureRef.current = [];
    setPast(nextPast);
    setFuture([]);
  }, []);

  /** AI-generated flows arrive as an overlapping stack; tidy them on first load. */
  const autoTidiedRef = useRef(false);
  useEffect(() => {
    if (autoTidiedRef.current) return;
    autoTidiedRef.current = true;
    const currentNodes = nodesRef.current;
    if (currentNodes.length < 2 || !nodesOverlap(currentNodes)) return;
    const laidOut = autoLayoutNodes(currentNodes, edgesRef.current);
    setNodes(laidOut);
    setBaseline(serializeFlow(laidOut, edgesRef.current));
    window.setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 0);
  }, [fitView, setNodes]);

  const tidyUp = useCallback(() => {
    pushHistory();
    setNodes(autoLayoutNodes(nodesRef.current, edgesRef.current));
    window.setTimeout(() => fitView({ padding: 0.2, duration: 200 }), 0);
  }, [fitView, pushHistory, setNodes]);

  const undo = useCallback(() => {
    const previous = pastRef.current[pastRef.current.length - 1];
    if (!previous) return;
    const nextPast = pastRef.current.slice(0, -1);
    const nextFuture = [...futureRef.current, { nodes: nodesRef.current, edges: edgesRef.current }];
    pastRef.current = nextPast;
    futureRef.current = nextFuture;
    setPast(nextPast);
    setFuture(nextFuture);
    setNodes(previous.nodes);
    setEdges(previous.edges);
  }, [setEdges, setNodes]);

  const redo = useCallback(() => {
    const next = futureRef.current[futureRef.current.length - 1];
    if (!next) return;
    const nextPast = [...pastRef.current, { nodes: nodesRef.current, edges: edgesRef.current }];
    const nextFuture = futureRef.current.slice(0, -1);
    pastRef.current = nextPast;
    futureRef.current = nextFuture;
    setPast(nextPast);
    setFuture(nextFuture);
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [setEdges, setNodes]);

  const handleSave = useCallback(() => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    pendingSaveRef.current = serializeFlow(currentNodes, currentEdges);
    onSave?.(currentNodes, currentEdges);
  }, [onSave]);

  const onConnect: OnConnect = useCallback(
    (params) => {
      pushHistory();
      setEdges((existing) => addEdge({ ...params, animated: true }, existing));
    },
    [pushHistory, setEdges],
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
      pushHistory();
      const id = freshNodeId(type);
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setNodes((existing) => [...existing, createFlowNode(type, position, id)]);
      setSelectedNodeId(id);
    },
    [pushHistory, screenToFlowPosition, setNodes],
  );

  /** Click-to-add: place the node under the selection and connect it automatically. */
  const handleAddNode = useCallback(
    (type: string) => {
      pushHistory();
      const currentNodes = nodesRef.current;
      const anchor =
        currentNodes.find((node) => node.id === selectedNodeId) ?? lowestNode(currentNodes) ?? null;
      const position = anchor
        ? {
            x: anchor.position.x,
            y: anchor.position.y + (anchor.measured?.height ?? LAYOUT_NODE_HEIGHT) + 80,
          }
        : { x: 240, y: 80 };
      const id = freshNodeId(type);
      setNodes((existing) => [...existing, createFlowNode(type, position, id)]);
      const anchorHasNext =
        !!anchor &&
        edgesRef.current.some(
          (edge) =>
            edge.source === anchor.id &&
            edge.sourceHandle !== 'true' &&
            edge.sourceHandle !== 'false',
        );
      if (anchor && anchor.type !== 'end' && anchor.type !== 'transfer' && !anchorHasNext) {
        setEdges((existing) =>
          addEdge(
            { id: `e-${anchor.id}-${id}`, source: anchor.id, target: id, animated: true },
            existing,
          ),
        );
      }
      setSelectedNodeId(id);
    },
    [pushHistory, selectedNodeId, setEdges, setNodes],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const target = nodesRef.current.find((node) => node.id === nodeId);
      if (!target || target.type === 'start') return;
      pushHistory();
      setNodes((existing) => existing.filter((node) => node.id !== nodeId));
      setEdges((existing) =>
        existing.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
      );
      setSelectedNodeId((current) => (current === nodeId ? null : current));
    },
    [pushHistory, setEdges, setNodes],
  );

  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const target = nodesRef.current.find((node) => node.id === nodeId);
      if (!target) return;
      pushHistory();
      const copy = duplicateFlowNode(target);
      setNodes((existing) => [...existing, copy]);
      setSelectedNodeId(copy.id);
    },
    [pushHistory, setNodes],
  );

  /** Removes the current selection, never the start node. */
  const deleteSelection = useCallback(() => {
    const selectedIds = new Set(
      nodesRef.current
        .filter((node) => (node.selected || node.id === selectedNodeId) && node.type !== 'start')
        .map((node) => node.id),
    );
    const selectedEdgeIds = new Set(
      edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id),
    );
    if (selectedIds.size === 0 && selectedEdgeIds.size === 0) return;
    pushHistory();
    setNodes((existing) => existing.filter((node) => !selectedIds.has(node.id)));
    setEdges((existing) =>
      existing.filter(
        (edge) =>
          !selectedEdgeIds.has(edge.id) &&
          !selectedIds.has(edge.source) &&
          !selectedIds.has(edge.target),
      ),
    );
    setSelectedNodeId((current) => (current && selectedIds.has(current) ? null : current));
  }, [pushHistory, selectedNodeId, setEdges, setNodes]);

  const handleConfigChange = useCallback(
    (nodeId: string, data: Record<string, unknown>) => {
      const editKey = `${nodeId}:${Object.keys(data).sort().join(',')}`;
      if (configEditKeyRef.current !== editKey) {
        pushHistory();
        configEditKeyRef.current = editKey;
      }
      if (configEditTimerRef.current) clearTimeout(configEditTimerRef.current);
      configEditTimerRef.current = setTimeout(() => {
        configEditKeyRef.current = null;
        configEditTimerRef.current = null;
      }, 400);
      setNodes((existing) => updateNodeData(existing as Node[], nodeId, data));
    },
    [pushHistory, setNodes],
  );

  useEffect(
    () => () => {
      if (configEditTimerRef.current) clearTimeout(configEditTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (issues.length === 0) handleSave();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteSelection, handleSave, issues, redo, undo]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {topBar ? (
        <FlowTopBar
          agentName={topBar.agentName}
          backHref={topBar.backHref}
          onNavigateAway={topBar.onNavigateAway}
          nodeCount={nodes.length}
          edgeCount={edges.length}
          issues={issues}
          isDirty={isDirty}
          isSaving={isSaving}
          onSave={handleSave}
        />
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-52 shrink-0 overflow-y-auto border-r border-border bg-sidebar md:block">
          <NodePalette onDragStart={onPaletteDragStart} onAddNode={handleAddNode} compact />
        </div>

        {/* ph-no-capture: node cards render spoken scripts and transfer numbers. */}
        <div className="ph-no-capture relative min-w-0 flex-1 bg-muted/30">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onNodeDragStart={() => {
              dragSnapshotRef.current = { nodes: nodesRef.current, edges: edgesRef.current };
            }}
            onNodeDragStop={() => {
              if (dragSnapshotRef.current) {
                pushHistory(dragSnapshotRef.current);
                dragSnapshotRef.current = null;
              }
            }}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={NODE_TYPES}
            deleteKeyCode={null}
            fitView
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable className="!bottom-4 !right-4" />
          </ReactFlow>

          <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-events-auto bg-background/95 backdrop-blur"
              onClick={tidyUp}
            >
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              Tidy up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-events-auto bg-background/95 backdrop-blur"
              onClick={undo}
              disabled={past.length === 0}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="pointer-events-auto bg-background/95 backdrop-blur"
              onClick={redo}
              disabled={future.length === 0}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="hidden w-[22rem] shrink-0 overflow-hidden border-l border-border bg-sidebar lg:block">
          <NodeConfigPanel
            node={selectedNode}
            availableTools={availableTools}
            onChange={handleConfigChange}
            onDelete={handleDeleteNode}
            onDuplicate={handleDuplicateNode}
          />
        </div>
      </div>
    </div>
  );
}

function onPaletteDragStart(event: React.DragEvent, nodeType: string) {
  event.dataTransfer.setData('application/reactflow', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

function lowestNode(nodes: Node[]): Node | null {
  return nodes.reduce<Node | null>(
    (lowest, node) => (!lowest || node.position.y > lowest.position.y ? node : lowest),
    null,
  );
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

/** Stable serialization of the parts of the graph that are persisted. */
function serializeFlow(nodes: Node[], edges: Edge[]): string {
  return JSON.stringify({
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      data: node.data,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  });
}
