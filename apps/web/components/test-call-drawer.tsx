'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CallDetail, TestSessionResult } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/cn';
import { ArrowRight, Clock3, MessageSquareText, Phone } from 'lucide-react';

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

  const turns = detailQuery.data?.turns ?? [];

  return (
    <>
      <Button
        variant="outline"
        type="button"
        onClick={() => startMutation.mutate()}
        disabled={startMutation.isPending || !workspaceId}
        className="gap-2"
      >
        <Phone className="h-4 w-4" />
        {startMutation.isPending ? 'Starting…' : 'Test call'}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex h-full w-full flex-col p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border px-6 py-5 pr-12 text-left">
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>Browser test call</SheetTitle>
              <StatusBadge status={detailQuery.data?.status ?? 'pending'} />
            </div>
            <SheetDescription>
              Review the generated browser test transcript before opening the full call record.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            {detailQuery.isPending ? (
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <Clock3 className="h-4 w-4 animate-pulse" />
                Loading transcript…
              </div>
            ) : turns.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {turns.map((turn, idx) => {
                  const isAgent = turn.speaker === 'agent';
                  return (
                    <li
                      key={`${turn.speaker}-${turn.at_ms}-${idx}`}
                      className={cn(
                        'flex max-w-[88%] flex-col rounded-2xl border px-4 py-3 text-sm shadow-sm',
                        isAgent
                          ? 'self-start border-border bg-muted/70'
                          : 'self-end border-primary/20 bg-primary text-primary-foreground',
                      )}
                    >
                      <span
                        className={cn(
                          'mb-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
                          isAgent ? 'text-muted-foreground' : 'text-primary-foreground/75',
                        )}
                      >
                        {turn.speaker} · {Math.round(turn.at_ms / 1000)}s
                      </span>
                      <span>{turn.text}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-muted/30 px-6 text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <MessageSquareText className="h-6 w-6" />
                </div>
                <p className="font-medium text-foreground">No transcript yet</p>
                <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                  The transcript appears here after the browser test session creates turns.
                </p>
              </div>
            )}
          </div>

          <SheetFooter className="border-t border-border px-6 py-4 sm:justify-between sm:space-x-0">
            <span className="text-xs text-muted-foreground">
              {callId ? `Call ${callId.slice(0, 8)}` : 'Browser test session'}
            </span>
            {callId ? (
              <Button asChild variant="outline" size="sm" className="gap-2">
                <Link href={`/dashboard/calls/${callId}`}>
                  Open full call
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}