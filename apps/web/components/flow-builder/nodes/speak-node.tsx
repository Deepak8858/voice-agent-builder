'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const SpeakNode = memo(function SpeakNode({ data }: NodeProps) {
  const text = (data?.text as string) ?? 'Agent speaks...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-blue-400 bg-blue-50 px-4 py-3 shadow-sm dark:bg-blue-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-500">LLM Speak</p>
      <p className="line-clamp-3 text-sm text-blue-900 dark:text-blue-100">{text}</p>
      <Handle type="target" position={Position.Top} className="!bg-blue-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-blue-400" />
    </div>
  );
});
