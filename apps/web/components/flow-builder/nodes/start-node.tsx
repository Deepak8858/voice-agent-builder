'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const StartNode = memo(function StartNode(_: NodeProps) {
  return (
    <div className="rounded-xl border-2 border-green-400 bg-green-50 px-4 py-3 text-sm font-semibold text-green-700 shadow-sm dark:border-green-600 dark:bg-green-950 dark:text-green-300">
      <Handle type="source" position={Position.Bottom} className="!bg-green-400" />
      Start
    </div>
  );
});
