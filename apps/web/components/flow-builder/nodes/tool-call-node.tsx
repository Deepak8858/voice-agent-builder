'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const ToolCallNode = memo(function ToolCallNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('tool_call');
  const toolName = typeof data?.tool_name === 'string' && data.tool_name.trim() ? data.tool_name : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Tool Call"
      theme={meta.theme}
      preview={toolName || 'No tool selected'}
      previewMono={Boolean(toolName)}
      incomplete={!toolName}
      selected={selected}
    >
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
