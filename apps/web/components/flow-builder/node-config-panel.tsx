'use client';

import { useCallback } from 'react';
import type { Node } from '@xyflow/react';
import type { ToolSummary } from '@voiceforge/shared';
import { Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { validateNodeConfig } from './flow-builder-model';
import { getNodeMeta } from './nodes/node-meta';

interface NodeConfigPanelProps {
  node: Node | null;
  availableTools?: ToolSummary[];
  onChange: (nodeId: string, data: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
}

interface FieldProps {
  label: string;
  helper: string;
  error?: string;
  children: React.ReactNode;
}

function Field({ label, helper, error, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      {children}
      <span className="text-[11px] leading-relaxed text-muted-foreground">{helper}</span>
      {error ? <span className="text-[11px] font-medium text-destructive">{error}</span> : null}
    </label>
  );
}

const selectClassName =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function NodeConfigPanel({
  node,
  availableTools = [],
  onChange,
  onDelete,
  onDuplicate,
}: NodeConfigPanelProps) {
  const handleChange = useCallback(
    (field: string, value: unknown) => {
      if (node) onChange(node.id, { [field]: value });
    },
    [node, onChange],
  );

  if (!node) {
    return (
      <div className="ph-no-capture flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-sm font-medium text-foreground">No node selected</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Select a node on the canvas to inspect and configure it.
        </p>
      </div>
    );
  }

  const issues = validateNodeConfig(node);
  const meta = getNodeMeta(node.type);
  const fieldError = (field: string) => issues.find((issue) => issue.field === field)?.message;

  return (
    /* ph-no-capture: this panel can contain spoken scripts, phone numbers,
       message bodies, and tool configuration. */
    <div className="ph-no-capture flex h-full flex-col">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <span className={`flex h-7 w-7 items-center justify-center rounded-md ${meta.palette}`}>
            <meta.icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{meta.label}</h2>
            <p className="text-[11px] text-muted-foreground">{meta.description}</p>
          </div>
        </div>
        {issues.length > 0 ? (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              {issues.length} field{issues.length === 1 ? '' : 's'} need attention
            </p>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="flex flex-col gap-5">
          {node.type === 'speak' ? (
            <Field
              label="Text to speak"
              helper="The exact words the agent says at this step."
              error={fieldError('text')}
            >
              <Textarea
                rows={5}
                value={typeof node.data?.text === 'string' ? node.data.text : ''}
                onChange={(event) => handleChange('text', event.target.value)}
                placeholder="What should the agent say?"
              />
            </Field>
          ) : null}

          {node.type === 'ask_question' ? (
            <>
              <Field
                label="Question"
                helper="Ask one clear question at a time."
                error={fieldError('question')}
              >
                <Textarea
                  rows={4}
                  value={typeof node.data?.question === 'string' ? node.data.question : ''}
                  onChange={(event) => handleChange('question', event.target.value)}
                  placeholder="What should the agent ask?"
                />
              </Field>
              <Field
                label="Capture field"
                helper="Variable name used to store the caller's answer, such as full_name."
                error={fieldError('capture_field')}
              >
                <Input
                  value={
                    typeof node.data?.capture_field === 'string' ? node.data.capture_field : ''
                  }
                  onChange={(event) => handleChange('capture_field', event.target.value)}
                  placeholder="full_name"
                  className="font-mono text-sm"
                />
              </Field>
            </>
          ) : null}

          {node.type === 'condition' ? (
            <Field
              label="Expression"
              helper="Routes the call through the true or false connection."
              error={fieldError('expression')}
            >
              <Input
                value={typeof node.data?.expression === 'string' ? node.data.expression : ''}
                onChange={(event) => handleChange('expression', event.target.value)}
                placeholder="intent === 'urgent'"
                className="font-mono text-sm"
              />
            </Field>
          ) : null}

          {node.type === 'tool_call' ? (
            <Field
              label="Tool"
              helper="Choose an enabled workspace tool to run at this step."
              error={fieldError('tool_name')}
            >
              <select
                className={selectClassName}
                value={typeof node.data?.tool_name === 'string' ? node.data.tool_name : ''}
                onChange={(event) => handleChange('tool_name', event.target.value)}
              >
                <option value="">Select a tool</option>
                {availableTools.map((tool) => (
                  <option key={tool.id} value={tool.name}>
                    {tool.name} ({tool.tool_type})
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {node.type === 'knowledge_lookup' ? (
            <Field
              label="Query field"
              helper="Optional variable to use as the search query; leave empty for the latest caller message."
            >
              <Input
                value={typeof node.data?.query_field === 'string' ? node.data.query_field : ''}
                onChange={(event) => handleChange('query_field', event.target.value)}
                placeholder="caller_question"
                className="font-mono text-sm"
              />
            </Field>
          ) : null}

          {node.type === 'transfer' ? (
            <Field
              label="Transfer phone number"
              helper="Use E.164 format. Leave empty to use the default human handoff destination."
              error={fieldError('target_phone')}
            >
              <Input
                value={typeof node.data?.target_phone === 'string' ? node.data.target_phone : ''}
                onChange={(event) => handleChange('target_phone', event.target.value)}
                placeholder="+14155551212"
                inputMode="tel"
              />
            </Field>
          ) : null}

          {node.type === 'send_message' ? (
            <>
              <Field
                label="Channel"
                helper="Choose how this message is delivered."
                error={fieldError('channel')}
              >
                <select
                  className={selectClassName}
                  value={
                    node.data?.channel === 'sms' || node.data?.channel === 'email'
                      ? node.data.channel
                      : ''
                  }
                  onChange={(event) => handleChange('channel', event.target.value)}
                >
                  <option value="" disabled>
                    Select a channel
                  </option>
                  <option value="sms">SMS</option>
                  <option value="email">Email</option>
                </select>
              </Field>
              <Field
                label="Message body"
                helper="The plain-text message sent to the contact."
                error={fieldError('body')}
              >
                <Textarea
                  rows={5}
                  value={typeof node.data?.body === 'string' ? node.data.body : ''}
                  onChange={(event) => handleChange('body', event.target.value)}
                  placeholder="Message to send"
                />
              </Field>
            </>
          ) : null}

          {node.type === 'fallback' ? (
            <Field
              label="Fallback message"
              helper="Optional safe response when the agent cannot confidently continue."
            >
              <Textarea
                rows={4}
                value={typeof node.data?.message === 'string' ? node.data.message : ''}
                onChange={(event) => handleChange('message', event.target.value)}
                placeholder="Let me connect you with someone who can help."
              />
            </Field>
          ) : null}

          {node.type === 'start' || node.type === 'end' ? (
            <p className="rounded-md border border-dashed border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              This node has no configurable fields.
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-border p-4">
        <Button type="button" variant="outline" size="sm" onClick={() => onDuplicate(node.id)}>
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Duplicate
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={node.type === 'start'}
          title={node.type === 'start' ? 'The start node cannot be deleted' : 'Delete node'}
          onClick={() => onDelete(node.id)}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
