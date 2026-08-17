'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const StartNode = memo(function StartNode({ selected }: NodeProps) {
  const meta = getNodeMeta('start');
  return (
    <NodeCard icon={meta.icon} title="Start" theme={meta.theme} preview="Call begins here" selected={selected}>
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
