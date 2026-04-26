'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CallDetail, TestSessionResult } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/cn';

interface TestCallDrawerProps {
  workspaceId: string;
  agentId: string;
}

export function TestCallDrawer({ workspaceId, agentId }: TestCallDrawerProps) {
  const { call } = useApi();
  const [open, setOpen] = useState(false);
  const [callId, setCallId] = useState<string | null>(null);

  const startMutation = useMutation({
    mutationFn: async () =>
      call<TestSessionResult>(
        `/workspaces/${workspaceId}/agents/${agentId}/test-session`,
        { method: 'POST', body: JSON.stringify({ contact_name: 'Browser tester' }) },
      ),
    onSuccess: (res) => {
      setCallId(res.call_id);
      setOpen(true);
      toast.success('Test session created.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const detailQuery = useQuery({
    queryKey: ['call', workspaceId, callId],
    enabled: Boolean(callId),
    queryFn: () => call<CallDetail>(`/workspaces/${workspaceId}/calls/${callId}`),
  });

  return (
    <>
      <Button variant="secondary" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
        {startMutation.isPending ? 'Starting…' : 'Test call'}
      </Button>

      {open && callId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/40 p-0 sm:items-center sm:p-6">
          <div className="flex h-full w-full max-w-xl flex-col rounded-none bg-white shadow-2xl dark:bg-zinc-950 sm:h-auto sm:max-h-[80vh] sm:rounded-2xl">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">Browser test call</h2>
                <Badge>{detailQuery.data?.status ?? 'pending'}</Badge>
              </div>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailQuery.isPending ? (
                <p className="text-sm text-zinc-500">Loading transcript…</p>
              ) : detailQuery.data ? (
                <ul className="space-y-2">
                  {detailQuery.data.turns.map((t, idx) => (
                    <li
                      key={idx}
                      className={cn(
                        'flex max-w-[85%] flex-col rounded-lg px-3 py-2 text-sm',
                        t.speaker === 'agent'
                          ? 'self-start bg-zinc-100 dark:bg-zinc-900'
                          : 'self-end bg-blue-50 dark:bg-blue-950/40',
                      )}
                    >
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                        {t.speaker} · {Math.round(t.at_ms / 1000)}s
                      </span>
                      <span>{t.text}</span>
                    </li>
                  ))}
                  {detailQuery.data.turns.length === 0 ? (
                    <li className="text-sm text-zinc-500">
                      No transcript yet. Mock provider returns scripted text only after the
                      session is created.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 text-xs text-zinc-500 dark:border-zinc-800">
              <span>Mock provider · transcript is scripted</span>
              <a className="underline" href={`/dashboard/calls/${callId}`}>
                Open full call →
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
