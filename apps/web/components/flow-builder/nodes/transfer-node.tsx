'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const TransferNode = memo(function TransferNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('transfer');
  const target =
    typeof data?.target_phone === 'string' && data.target_phone.trim() ? data.target_phone : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Transfer"
      theme={meta.theme}
      preview={target || 'Human agent'}
      previewMono={Boolean(target)}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
    </NodeCard>
  );
});
