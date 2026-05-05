'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CallDetail, TestSessionResult } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/cn';
import { Phone, X, ArrowRight } from 'lucide-react';

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
      <Button variant="outline" onClick={() => startMutation.mutate()} disabled={startMutation.isPending} className="gap-2">
        <Phone className="h-4 w-4" />
        {startMutation.isPending ? 'Starting…' : 'Test call'}
      </Button>

      {open && callId ? (
        <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/40 p-0 sm:items-center sm:p-6">
          <div className="flex h-full w-full max-w-xl flex-col rounded-none bg-background shadow-2xl sm:h-auto sm:max-h-[80vh] sm:rounded-2xl border border-border">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground">Browser test call</h2>
                <Badge variant="secondary">{detailQuery.data?.status ?? 'pending'}</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} className="gap-1">
                <X className="h-4 w-4" />
                Close
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {detailQuery.isPending ? (
                <p className="text-sm text-muted-foreground">Loading transcript…</p>
              ) : detailQuery.data ? (
                <ul className="space-y-3">
                  {detailQuery.data.turns.map((t, idx) => (
                    <li
                      key={idx}
                      className={cn(
                        'flex max-w-[85%] flex-col rounded-xl px-4 py-3 text-sm',
                        t.speaker === 'agent'
                          ? 'self-start bg-muted border border-border'
                          : 'self-end bg-primary/10 text-primary-foreground border border-primary/20',
                      )}
                    >
                      <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground mb-1">
                        {t.speaker} · {Math.round(t.at_ms / 1000)}s
                      </span>
                      <span className="text-foreground">{t.text}</span>
                    </li>
                  ))}
                  {detailQuery.data.turns.length === 0 ? (
                    <li className="text-sm text-muted-foreground">
                      No transcript yet. Transcript appears once the session ends.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
              <span>Browser test session</span>
              <a className="inline-flex items-center gap-1 text-primary hover:underline" href={`/dashboard/calls/${callId}`}>
                Open full call
                <ArrowRight className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
