'use client';

import { useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Edge, Node } from '@xyflow/react';
import { FlowBuilder } from './flow-builder';
import { useApi } from '@/lib/use-api';

interface FlowBuilderClientProps {
  workspaceId: string;
  agentId: string;
  initialFlow?: { nodes: Node[]; edges: Edge[] };
}

export function FlowBuilderClient({ workspaceId, agentId, initialFlow }: FlowBuilderClientProps) {
  const { call } = useApi();

  const saveMutation = useMutation({
    mutationFn: async ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      return call(`/workspaces/${workspaceId}/agents/${agentId}/flow`, {
        method: 'PUT',
        body: JSON.stringify({ nodes, edges }),
      });
    },
    onSuccess: () => toast.success('Flow saved.'),
    onError: (err: Error) => toast.error(err.message),
  });

  const handleSave = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      saveMutation.mutate({ nodes, edges });
    },
    [saveMutation],
  );

  return (
    <div className="h-[600px] rounded-xl border border-zinc-200 overflow-hidden dark:border-zinc-800">
      <FlowBuilder
        initialNodes={initialFlow?.nodes}
        initialEdges={initialFlow?.edges}
        onSave={handleSave}
      />
    </div>
  );
}
