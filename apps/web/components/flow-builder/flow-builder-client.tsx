'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Edge, Node } from '@xyflow/react';
import { ToolSummarySchema } from '@voiceforge/shared';
import { useApi } from '@/lib/use-api';
import posthog from 'posthog-js';
import { FlowBuilder } from './flow-builder';

interface FlowBuilderClientProps {
  workspaceId: string;
  agentId: string;
  agentName?: string;
  initialFlow?: { nodes: Node[]; edges: Edge[] };
}

const ToolsResponseSchema = z.object({ items: z.array(ToolSummarySchema) });

export function FlowBuilderClient({
  workspaceId,
  agentId,
  agentName,
  initialFlow,
}: FlowBuilderClientProps) {
  const { call } = useApi();
  const router = useRouter();
  const [savedSignal, setSavedSignal] = useState(0);
  const isDirtyRef = useRef(false);

  const handleDirtyChange = useCallback((dirty: boolean) => {
    isDirtyRef.current = dirty;
  }, []);

  const toolsQuery = useQuery({
    queryKey: ['flow-builder-tools', workspaceId, agentId],
    queryFn: async () =>
      ToolsResponseSchema.parse(await call<unknown>(`/workspaces/${workspaceId}/tools`)),
  });

  const saveMutation = useMutation({
    mutationFn: async ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) =>
      call(`/workspaces/${workspaceId}/agents/${agentId}/flow`, {
        method: 'PUT',
        body: JSON.stringify({ nodes, edges }),
      }),
    onSuccess: () => {
      posthog.capture('agent_flow_saved');
      toast.success('Flow saved.');
      // Reconcile locally instead of router.refresh() so the canvas keeps its
      // viewport, selection, and history.
      setSavedSignal((signal) => signal + 1);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /** Warn before losing unsaved edits on reload or tab close. */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const confirmDiscard = useCallback(
    () =>
      !isDirtyRef.current || window.confirm('You have unsaved flow changes. Leave without saving?'),
    [],
  );

  const handleBack = useCallback(
    (event: React.MouseEvent) => {
      if (!confirmDiscard()) {
        event.preventDefault();
        return;
      }
      // Let Next.js handle navigation; refresh so the builder page picks up the
      // saved flow when returning.
      router.refresh();
    },
    [confirmDiscard, router],
  );

  const handleSave = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      saveMutation.mutate({ nodes, edges });
    },
    [saveMutation],
  );

  return (
    <FlowBuilder
      initialNodes={initialFlow?.nodes}
      initialEdges={initialFlow?.edges}
      availableTools={(toolsQuery.data?.items ?? []).filter((tool) => tool.enabled)}
      isSaving={saveMutation.isPending}
      onSave={handleSave}
      savedSignal={savedSignal}
      onDirtyChange={handleDirtyChange}
      topBar={{
        agentName,
        backHref: `/dashboard/agents/${agentId}/builder`,
        onNavigateAway: handleBack,
      }}
    />
  );
}
