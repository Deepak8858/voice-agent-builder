'use client';

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AgentSpecSchema, type AgentDetail, type AgentSpec } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { FormModeEditor, type AgentSpecValidationState } from '@/components/form-mode-editor';
import { useApi } from '@/lib/use-api';
import { Save } from 'lucide-react';

interface AgentSpecVersionEditorProps {
  workspaceId: string;
  agentId: string;
  initialSpec: AgentSpec | null;
}

export function AgentSpecVersionEditor({
  workspaceId,
  agentId,
  initialSpec,
}: AgentSpecVersionEditorProps) {
  const { call } = useApi();
  const [spec, setSpec] = useState<unknown | null>(initialSpec);
  const [baselineSpec, setBaselineSpec] = useState<unknown | null>(initialSpec);
  const [validation, setValidation] = useState<AgentSpecValidationState | null>(null);

  const parsedSpec = useMemo(
    () => (spec ? AgentSpecSchema.safeParse(spec) : null),
    [spec],
  );
  const hasChanges = useMemo(
    () => stringifyForCompare(spec) !== stringifyForCompare(baselineSpec),
    [baselineSpec, spec],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!spec) throw new Error('No Agent Spec to save');
      const parsed = AgentSpecSchema.safeParse(spec);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const field = firstIssue?.path.length ? firstIssue.path.join('.') : 'spec';
        throw new Error(`Fix Agent Spec validation before saving: ${field}`);
      }

      return call<AgentDetail>(
        `/workspaces/${workspaceId}/agents/${agentId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({
            spec: parsed.data,
            note: 'Updated in builder spec editor',
          }),
        },
      );
    },
    onSuccess: () => {
      const parsed = AgentSpecSchema.safeParse(spec);
      if (parsed.success) setBaselineSpec(parsed.data);
      toast.success('Agent version saved. Publish to deploy the latest version.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!spec) {
    return (
      <p className="text-sm text-muted-foreground">
        No active version. Save a draft spec first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FormModeEditor
        spec={spec}
        onChange={setSpec}
        defaultMode="form"
        onValidationChange={setValidation}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !parsedSpec?.success || !hasChanges}
          className="gap-2"
        >
          <Save className="h-4 w-4" />
          {saveMutation.isPending ? 'Saving...' : 'Save new version'}
        </Button>
        {validation && !validation.isValid ? (
          <span className="text-xs text-destructive">
            Resolve Agent Spec validation issues to save.
          </span>
        ) : hasChanges ? (
          <span className="text-xs text-muted-foreground">
            Unsaved spec changes will be stored as a new version.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function stringifyForCompare(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '';
  }
}
