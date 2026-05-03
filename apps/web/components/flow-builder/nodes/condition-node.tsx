'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const ConditionNode = memo(function ConditionNode({ data }: NodeProps) {
  const expr = (data?.expression as string) ?? 'condition...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3 shadow-sm dark:bg-amber-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-500">Condition</p>
      <p className="line-clamp-2 text-sm font-mono text-amber-900 dark:text-amber-100">{expr}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-600">True →</span>
        <span className="text-xs font-medium text-red-500">→ False</span>
      </div>
      <Handle type="target" position={Position.Top} className="!bg-amber-400" />
      <Handle type="source" position={Position.Bottom} id="true" className="!bg-emerald-500" />
      <Handle type="source" position={Position.Right} id="false" className="!bg-red-500" />
    </div>
  );
});
