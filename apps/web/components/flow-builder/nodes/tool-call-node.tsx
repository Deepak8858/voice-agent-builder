'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const ToolCallNode = memo(function ToolCallNode({ data }: NodeProps) {
  const toolName = (data?.tool_name as string) ?? 'tool...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-orange-400 bg-orange-50 px-4 py-3 shadow-sm dark:bg-orange-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-orange-500">Tool Call</p>
      <p className="font-mono text-sm text-orange-900 dark:text-orange-100">{toolName}</p>
      <Handle type="target" position={Position.Top} className="!bg-orange-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-orange-400" />
    </div>
  );
});
