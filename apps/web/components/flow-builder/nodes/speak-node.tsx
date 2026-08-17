'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const SpeakNode = memo(function SpeakNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('speak');
  const text = typeof data?.text === 'string' && data.text.trim() ? data.text : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Speak"
      theme={meta.theme}
      preview={text || 'No script yet'}
      incomplete={!text}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
