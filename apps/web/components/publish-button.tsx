'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/use-api';

interface PublishButtonProps {
  workspaceId: string;
  agentId: string;
  status: string;
}

export function PublishButton({ workspaceId, agentId, status }: PublishButtonProps) {
  const { call } = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const publish = useMutation({
    mutationFn: async () =>
      call<unknown>(`/workspaces/${workspaceId}/agents/${agentId}/publish`, {
        method: 'POST',
      }),
    onSuccess: () => {
      setError(null);
      router.refresh();
    },
    onError: (err: Error & { code?: string }) => {
      if (err.code === 'PLAN_LIMIT_EXCEEDED' || err.code === 'BILLING_GATE_EXCEEDED') {
        router.push('/dashboard/billing');
        return;
      }
      setError(err.message);
    },
  });

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={() => publish.mutate()}
        disabled={publish.isPending || status === 'published'}
      >
        {publish.isPending
          ? 'Publishing…'
          : status === 'published'
            ? 'Published'
            : 'Publish'}
      </Button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
