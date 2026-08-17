'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const ConditionNode = memo(function ConditionNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('condition');
  const expr = typeof data?.expression === 'string' && data.expression.trim() ? data.expression : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Condition"
      theme={meta.theme}
      preview={expr || 'No expression yet'}
      previewMono
      incomplete={!expr}
      selected={selected}
    >
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs font-medium text-emerald-600">True ↓</span>
        <span className="text-xs font-medium text-red-500">False →</span>
      </div>
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} id="true" className="!bg-emerald-500" />
      <Handle type="source" position={Position.Right} id="false" className="!bg-red-500" />
    </NodeCard>
  );
});
