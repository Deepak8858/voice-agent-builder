'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const FallbackNode = memo(function FallbackNode({ data }: NodeProps) {
  const message = (data?.message as string) || 'Fallback to a safer response...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-slate-400 bg-slate-50 px-4 py-3 shadow-sm dark:bg-slate-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Fallback</p>
      <p className="line-clamp-3 text-sm text-slate-900 dark:text-slate-100">{message}</p>
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
});
