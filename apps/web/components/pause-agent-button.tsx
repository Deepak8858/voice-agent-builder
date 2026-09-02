'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentDetail } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';
import { PauseCircle } from 'lucide-react';

interface PauseAgentButtonProps {
  workspaceId: string;
  agentId: string;
}

/**
 * POST /agents/:id/pause has existed since agents shipped, with no way to reach
 * it from the dashboard — so a published agent could only ever be republished,
 * never taken off live traffic. Render this only for a published agent; pausing
 * a draft is a no-op that still writes an audit row.
 */
export function PauseAgentButton({ workspaceId, agentId }: PauseAgentButtonProps) {
  const router = useRouter();
  const { call } = useApi();

  const pause = useMutation({
    mutationFn: () =>
      call<AgentDetail>(`/workspaces/${workspaceId}/agents/${agentId}/pause`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Agent paused. It will not take new calls.');
      router.refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Button
      variant="outline"
      onClick={() => pause.mutate()}
      disabled={pause.isPending}
      className="gap-2"
    >
      <PauseCircle className="h-4 w-4" />
      {pause.isPending ? 'Pausing...' : 'Pause'}
    </Button>
  );
}
