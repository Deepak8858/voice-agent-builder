'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const EndNode = memo(function EndNode(_: NodeProps) {
  return (
    <div className="rounded-xl border-2 border-zinc-300 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-600 shadow-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
      <Handle type="target" position={Position.Top} className="!bg-zinc-400" />
      End
    </div>
  );
});
