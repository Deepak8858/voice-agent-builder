'use client';

import type { NodeTypes } from '@xyflow/react';
import { StartNode } from './nodes/start-node';
import { SpeakNode } from './nodes/speak-node';
import { AskQuestionNode } from './nodes/ask-question-node';
import { ConditionNode } from './nodes/condition-node';
import { ToolCallNode } from './nodes/tool-call-node';
import { TransferNode } from './nodes/transfer-node';
import { EndNode } from './nodes/end-node';

export const NODE_PALETTE = [
  { type: 'start', label: 'Start', icon: '▶', color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  { type: 'speak', label: 'LLM Speak', icon: '💬', color: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  { type: 'ask_question', label: 'Ask Question', icon: '❓', color: 'bg-violet-500/10 text-violet-600 border-violet-500/20' },
  { type: 'condition', label: 'Condition', icon: '🔀', color: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  { type: 'tool_call', label: 'Tool Call', icon: '🔧', color: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  { type: 'transfer', label: 'Transfer', icon: '📞', color: 'bg-red-500/10 text-red-600 border-red-500/20' },
  { type: 'end', label: 'End', icon: '■', color: 'bg-muted text-muted-foreground border-border' },
] as const;

export const NODE_TYPES: NodeTypes = {
  start: StartNode,
  speak: SpeakNode,
  ask_question: AskQuestionNode,
  condition: ConditionNode,
  tool_call: ToolCallNode,
  transfer: TransferNode,
  end: EndNode,
};

interface NodePaletteProps {
  onDragStart: (event: React.DragEvent, nodeType: string) => void;
}

export function NodePalette({ onDragStart }: NodePaletteProps) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
        Node Types
      </p>
      {NODE_PALETTE.map(({ type, label, icon, color }) => (
        <div
          key={type}
          draggable
          onDragStart={(e) => onDragStart(e, type)}
          className={`flex cursor-grab items-center gap-3 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all hover:opacity-80 active:cursor-grabbing ${color}`}
        >
          <span className="text-base">{icon}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
