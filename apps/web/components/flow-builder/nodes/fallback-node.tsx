'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const FallbackNode = memo(function FallbackNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('fallback');
  const message = typeof data?.message === 'string' && data.message.trim() ? data.message : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Fallback"
      theme={meta.theme}
      preview={message || 'Fallback to a safer response'}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
