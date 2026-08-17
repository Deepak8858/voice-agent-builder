'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NodeCard } from './node-card';
import { getNodeMeta } from './node-meta';

export const AskQuestionNode = memo(function AskQuestionNode({ data, selected }: NodeProps) {
  const meta = getNodeMeta('ask_question');
  const question = typeof data?.question === 'string' && data.question.trim() ? data.question : '';
  const captureField =
    typeof data?.capture_field === 'string' && data.capture_field.trim() ? data.capture_field : '';
  return (
    <NodeCard
      icon={meta.icon}
      title="Ask Question"
      theme={meta.theme}
      preview={question || 'No question yet'}
      incomplete={!question || !captureField}
      selected={selected}
    >
      {captureField ? (
        <p className="mt-1 truncate text-xs text-violet-500">Captures: {captureField}</p>
      ) : null}
      <Handle type="target" position={Position.Top} className={meta.theme.handle} />
      <Handle type="source" position={Position.Bottom} className={meta.theme.handle} />
    </NodeCard>
  );
});
