'use client';

import { useCallback } from 'react';
import type { Node } from '@xyflow/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Loader2, Save } from 'lucide-react';

interface NodeConfigPanelProps {
  node: Node | null;
  onChange: (nodeId: string, data: Record<string, unknown>) => void;
  onSave: () => void;
  isSaving?: boolean;
}

export function NodeConfigPanel({ node, onChange, onSave, isSaving = false }: NodeConfigPanelProps) {
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
        <p className="text-sm text-muted-foreground">Select a node to configure it.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize text-foreground">
          {node.type?.replace('_', ' ')}
        </h3>
        <Button size="sm" onClick={onSave} disabled={isSaving} className="gap-1">
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {node.type === 'speak' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Text to speak</span>
            <Textarea
              rows={4}
              value={(node.data?.text as string) ?? ''}
              onChange={(e) => handleChange('text', e.target.value)}
              placeholder="What should the agent say?"
            />
          </label>
        )}

        {node.type === 'ask_question' && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Question</span>
              <Textarea
                rows={3}
                value={(node.data?.question as string) ?? ''}
                onChange={(e) => handleChange('question', e.target.value)}
                placeholder="What should the agent ask?"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Capture field name</span>
              <Input
                type="text"
                value={(node.data?.capture_field as string) ?? ''}
                onChange={(e) => handleChange('capture_field', e.target.value)}
                placeholder="e.g. full_name"
              />
            </label>
          </>
        )}

        {node.type === 'condition' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Expression</span>
            <Input
              type="text"
              className="font-mono text-xs"
              value={(node.data?.expression as string) ?? ''}
              onChange={(e) => handleChange('expression', e.target.value)}
              placeholder="e.g. full_name contains 'urgent'"
            />
          </label>
        )}

        {node.type === 'tool_call' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Tool name</span>
            <Input
              type="text"
              className="font-mono text-xs"
              value={(node.data?.tool_name as string) ?? ''}
              onChange={(e) => handleChange('tool_name', e.target.value)}
              placeholder="e.g. google_calendar.book_slot"
            />
          </label>
        )}

        {node.type === 'knowledge_lookup' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Query field</span>
            <Input
              type="text"
              className="font-mono text-xs"
              value={(node.data?.query_field as string) ?? ''}
              onChange={(e) => handleChange('query_field', e.target.value)}
              placeholder="e.g. caller_question"
            />
          </label>
        )}

        {node.type === 'transfer' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Transfer to (phone)</span>
            <Input
              type="text"
              value={(node.data?.target_phone as string) ?? ''}
              onChange={(e) => handleChange('target_phone', e.target.value)}
              placeholder="+14155551212 or leave empty for human agent"
            />
          </label>
        )}

        {node.type === 'send_message' && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Channel</span>
              <Input
                type="text"
                value={(node.data?.channel as string) ?? 'sms'}
                onChange={(e) => handleChange('channel', e.target.value)}
                placeholder="sms or email"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Message body</span>
              <Textarea
                rows={4}
                value={(node.data?.body as string) ?? ''}
                onChange={(e) => handleChange('body', e.target.value)}
                placeholder="Message to send"
              />
            </label>
          </>
        )}

        {node.type === 'fallback' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Fallback message</span>
            <Textarea
              rows={3}
              value={(node.data?.message as string) ?? ''}
              onChange={(e) => handleChange('message', e.target.value)}
              placeholder="What should the agent say when it is unsure?"
            />
          </label>
        )}

        {(node.type === 'start' || node.type === 'end') && (
          <p className="text-xs text-muted-foreground">
            No configuration needed for {node.type} nodes.
          </p>
        )}
      </div>
    </div>
  );
}
