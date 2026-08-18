'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const KnowledgeLookupNode = memo(function KnowledgeLookupNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('knowledge_lookup');
  const queryField =
    typeof data?.query_field === 'string' && data.query_field.trim() ? data.query_field : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Knowledge"
      theme={meta.theme}
      preview={queryField || 'Latest caller question'}
      previewMono={Boolean(queryField)}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
