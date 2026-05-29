'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

export const SendMessageNode = memo(function SendMessageNode({ data }: NodeProps) {
  const channel = (data?.channel as string) || 'sms';
  const body = (data?.body as string) || 'Message body...';
  return (
    <div className="min-w-[200px] rounded-xl border-2 border-teal-400 bg-teal-50 px-4 py-3 shadow-sm dark:bg-teal-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-teal-600">
        Send {channel}
      </p>
      <p className="line-clamp-3 text-sm text-teal-900 dark:text-teal-100">{body}</p>
      <Handle type="target" position={Position.Top} className="!bg-teal-400" />
      <Handle type="source" position={Position.Bottom} className="!bg-teal-400" />
    </div>
  );
});
