'use client';

import { useCallback } from 'react';
import type { NodeTypes } from '@xyflow/react';
import { StartNode } from './nodes/start-node';
import { SpeakNode } from './nodes/speak-node';
import { AskQuestionNode } from './nodes/ask-question-node';
import { ConditionNode } from './nodes/condition-node';
import { ToolCallNode } from './nodes/tool-call-node';
import { TransferNode } from './nodes/transfer-node';
import { EndNode } from './nodes/end-node';

export const NODE_PALETTE = [
  { type: 'start', label: 'Start', icon: '▶', color: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800' },
  { type: 'speak', label: 'LLM Speak', icon: '💬', color: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800' },
  { type: 'ask_question', label: 'Ask Question', icon: '❓', color: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800' },
  { type: 'condition', label: 'Condition', icon: '🔀', color: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800' },
  { type: 'tool_call', label: 'Tool Call', icon: '🔧', color: 'bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-800' },
  { type: 'transfer', label: 'Transfer', icon: '📞', color: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800' },
  { type: 'end', label: 'End', icon: '■', color: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700' },
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
    <div className="flex flex-col gap-2 p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Node Types
      </p>
      {NODE_PALETTE.map(({ type, label, icon, color }) => (
        <div
          key={type}
          draggable
          onDragStart={(e) => onDragStart(e, type)}
          className={`flex cursor-grab items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:opacity-80 active:cursor-grabbing ${color}`}
        >
          <span>{icon}</span>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
