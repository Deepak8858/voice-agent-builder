'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const StartNode = memo(function StartNode(_: NodeProps) {
  return (
    <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700 shadow-sm dark:bg-emerald-950/40 dark:text-emerald-300">
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-500" />
      Start
    </div>
  );
});
