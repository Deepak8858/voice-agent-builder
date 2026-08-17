'use client';

import type { NodeTypes } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { StartNode } from './nodes/start-node';
import { SpeakNode } from './nodes/speak-node';
import { AskQuestionNode } from './nodes/ask-question-node';
import { ConditionNode } from './nodes/condition-node';
import { FallbackNode } from './nodes/fallback-node';
import { KnowledgeLookupNode } from './nodes/knowledge-lookup-node';
import { SendMessageNode } from './nodes/send-message-node';
import { ToolCallNode } from './nodes/tool-call-node';
import { TransferNode } from './nodes/transfer-node';
import { EndNode } from './nodes/end-node';
import { NODE_META } from './nodes/node-meta';

/** Node types available in the palette (start is placed once automatically). */
const PALETTE_TYPES = [
  'speak',
  'ask_question',
  'condition',
  'knowledge_lookup',
  'tool_call',
  'transfer',
  'send_message',
  'fallback',
  'end',
] as const;

export const NODE_PALETTE = PALETTE_TYPES.map((type) => {
  const meta = NODE_META[type];
  return {
    type,
    label: meta?.label ?? type,
    description: meta?.description ?? '',
    icon: meta?.icon,
    color: meta?.palette ?? '',
  };
});

export const NODE_TYPES: NodeTypes = {
  start: StartNode,
  speak: SpeakNode,
  ask_question: AskQuestionNode,
  condition: ConditionNode,
  knowledge_lookup: KnowledgeLookupNode,
  tool_call: ToolCallNode,
  transfer: TransferNode,
  send_message: SendMessageNode,
  fallback: FallbackNode,
  end: EndNode,
};

interface NodePaletteProps {
  onDragStart: (event: React.DragEvent, nodeType: string) => void;
  /** Click-to-add: appends the node below the current selection and connects it. */
  onAddNode?: (nodeType: string) => void;
  compact?: boolean;
}

export function NodePalette({ onDragStart, onAddNode, compact = false }: NodePaletteProps) {
  return (
    <div className={compact ? 'flex flex-col gap-1.5 p-3' : 'flex flex-col gap-2 p-4'}>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
        Add nodes
      </p>
      <p className="mb-2 text-[11px] leading-snug text-sidebar-foreground/50">
        Click to add after the selected node, or drag onto the canvas.
      </p>
      {NODE_PALETTE.map(({ type, label, icon: Icon, color }) => (
        <button
          key={type}
          type="button"
          draggable
          onDragStart={(e) => onDragStart(e, type)}
          onClick={() => onAddNode?.(type)}
          title={`Add ${label}`}
          className={`group flex w-full cursor-grab items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm font-medium transition-all hover:opacity-80 active:cursor-grabbing ${color}`}
        >
          {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {onAddNode ? (
            <Plus className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" aria-hidden />
          ) : null}
        </button>
      ))}
    </div>
  );
}
