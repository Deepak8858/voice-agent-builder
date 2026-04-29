'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const AskQuestionNode = memo(function AskQuestionNode({ data }: NodeProps) {
  const question = (data?.question as string) ?? 'Ask a question...';
  const captureField = (data?.capture_field as string) ?? '';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-violet-300 bg-violet-50 px-4 py-3 shadow-sm dark:border-violet-700 dark:bg-violet-950">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-violet-500">Ask Question</p>
      <p className="mb-1 line-clamp-2 text-sm text-violet-900 dark:text-violet-100">{question}</p>
      {captureField ? (
        <p className="text-xs text-violet-500">Captures: {captureField}</p>
      ) : null}
      <Handle type="target" position={Position.Top} className="!bg-violet-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-violet-400" />
    </div>
  );
});
