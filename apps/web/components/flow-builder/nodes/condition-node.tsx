'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const ConditionNode = memo(function ConditionNode({ data }: NodeProps) {
  const expr = (data?.expression as string) ?? 'condition...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 shadow-sm dark:border-amber-700 dark:bg-amber-950">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-500">Condition</p>
      <p className="line-clamp-2 text-sm font-mono text-amber-900 dark:text-amber-100">{expr}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs font-medium text-amber-600">True →</span>
        <span className="text-xs font-medium text-red-600">→ False</span>
      </div>
      <Handle type="target" position={Position.Top} className="!bg-amber-400" />
      <Handle type="source" position={Position.Bottom} id="true" className="!bg-green-400" />
      <Handle type="source" position={Position.Right} id="false" className="!bg-red-400" />
    </div>
  );
});
