'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const EndNode = memo(function EndNode({ selected }: NodeProps) {
  const meta = getNodeMeta('end');
  return (
    <NodeCard icon={meta.icon} title="End" theme={meta.theme} preview="Call ends here" selected={selected}>
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
    </NodeCard>
  );
});
