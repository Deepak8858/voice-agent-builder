'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const SendMessageNode = memo(function SendMessageNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('send_message');
  const channel = data?.channel === 'email' ? 'Email' : 'SMS';
  const body = typeof data?.body === 'string' && data.body.trim() ? data.body : '';
  return (
    <NodeCard
      icon={meta.icon}
      title={`Send ${channel}`}
      theme={meta.theme}
      preview={body || 'No message yet'}
      incomplete={!body}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
