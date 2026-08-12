'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AgentDetail } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';
import { Rocket } from 'lucide-react';
import posthog from 'posthog-js';

interface PublishAgentButtonProps {
  workspaceId: string;
  agentId: string;
}

export function PublishAgentButton({ workspaceId, agentId }: PublishAgentButtonProps) {
  const router = useRouter();
  const { call } = useApi();

  const publish = useMutation({
    mutationFn: () =>
      call<AgentDetail>(`/workspaces/${workspaceId}/agents/${agentId}/publish`, {
        method: 'POST',
      }),
    onSuccess: () => {
      posthog.capture('agent_published');
      toast.success('Agent published.');
      router.refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Button onClick={() => publish.mutate()} disabled={publish.isPending} className="gap-2">
      <Rocket className="h-4 w-4" />
      {publish.isPending ? 'Publishing...' : 'Publish'}
    </Button>
  );
}
