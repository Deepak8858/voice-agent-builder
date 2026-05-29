'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const KnowledgeLookupNode = memo(function KnowledgeLookupNode({ data }: NodeProps) {
  const queryField = (data?.query_field as string) || 'latest caller question';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-cyan-400 bg-cyan-50 px-4 py-3 shadow-sm dark:bg-cyan-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-cyan-600">Knowledge</p>
      <p className="font-mono text-sm text-cyan-900 dark:text-cyan-100">{queryField}</p>
      <Handle type="target" position={Position.Top} className="!bg-cyan-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-400" />
    </div>
  );
});
