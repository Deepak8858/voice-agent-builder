'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const EndNode = memo(function EndNode(_: NodeProps) {
  return (
    <div className="rounded-xl border-2 border-border bg-muted px-4 py-3 text-sm font-semibold text-muted-foreground shadow-sm">
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      End
    </div>
  );
});
