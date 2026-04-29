'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const TransferNode = memo(function TransferNode({ data }: NodeProps) {
  const target = (data?.target_phone as string) ?? 'Transfer to...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 shadow-sm dark:border-red-700 dark:bg-red-950">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-500">Transfer</p>
      <p className="font-mono text-sm text-red-900 dark:text-red-100">{target || 'Human agent'}</p>
      <Handle type="target" position={Position.Top} className="!bg-red-400" />
    </div>
  );
});
