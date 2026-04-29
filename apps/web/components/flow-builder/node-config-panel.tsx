'use client';

import { useCallback } from 'react';
import type { Node } from '@xyflow/react';
import { Button } from '@/components/ui/button';

interface NodeConfigPanelProps {
  node: Node | null;
  onChange: (nodeId: string, data: Record<string, unknown>) => void;
  onSave: () => void;
}

export function NodeConfigPanel({ node, onChange, onSave }: NodeConfigPanelProps) {
  const handleChange = useCallback(
    (field: string, value: unknown) => {
      if (!node) return;
      onChange(node.id, { [field]: value });
    },
    [node, onChange],
  );

  if (!node) {
    return (
      <div className="flex h-full flex-col p-4">
        <p className="text-sm text-zinc-500">Select a node to configure it.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">
          {node.type?.replace('_', ' ')}
        </h3>
        <Button size="sm" onClick={onSave}>Save</Button>
      </div>

      <div className="flex flex-col gap-3">
        {node.type === 'speak' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Text to speak</span>
            <textarea
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              rows={4}
              value={(node.data?.text as string) ?? ''}
              onChange={(e) => handleChange('text', e.target.value)}
              placeholder="What should the agent say?"
            />
          </label>
        )}

        {node.type === 'ask_question' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-500">Question</span>
              <textarea
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                rows={3}
                value={(node.data?.question as string) ?? ''}
                onChange={(e) => handleChange('question', e.target.value)}
                placeholder="What should the agent ask?"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-500">Capture field name</span>
              <input
                type="text"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                value={(node.data?.capture_field as string) ?? ''}
                onChange={(e) => handleChange('capture_field', e.target.value)}
                placeholder="e.g. full_name"
              />
            </label>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-500">Expression</span>
              <input
                type="text"
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900"
                value={(node.data?.expression as string) ?? ''}
                onChange={(e) => handleChange('expression', e.target.value)}
                placeholder="e.g. full_name contains 'urgent'"
              />
            </label>
          </>
        )}

        {node.type === 'tool_call' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Tool name</span>
            <input
              type="text"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-900"
              value={(node.data?.tool_name as string) ?? ''}
              onChange={(e) => handleChange('tool_name', e.target.value)}
              placeholder="e.g. google_calendar.book_slot"
            />
          </label>
        )}

        {node.type === 'transfer' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Transfer to (phone)</span>
            <input
              type="text"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              value={(node.data?.target_phone as string) ?? ''}
              onChange={(e) => handleChange('target_phone', e.target.value)}
              placeholder="+14155551212 or leave empty for human agent"
            />
          </label>
        )}

        {(node.type === 'start' || node.type === 'end') && (
          <p className="text-xs text-zinc-500">
            No configuration needed for {node.type} nodes.
          </p>
        )}
      </div>
    </div>
  );
}
