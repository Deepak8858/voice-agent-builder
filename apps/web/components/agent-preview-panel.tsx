'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/dashboard/status-badge';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore, type GenerationStatus } from '@/lib/stores/agent-draft';
import { FormModeEditor } from '@/components/form-mode-editor';
import { Bot, CheckCircle2, Circle, Clock, FileJson2, Loader2, Mic2, XCircle } from 'lucide-react';

function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full rounded-full bg-muted overflow-hidden ${className ?? ''}`}>
      <div className="h-full bg-primary transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}

function StepStatus({ label, status }: { label: string; status: string }) {
  const icons = {
    pending: <Circle className="h-4 w-4 text-muted-foreground" />,
    processing: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
    done: <CheckCircle2 className="h-4 w-4 text-green-500" />,
    failed: <XCircle className="h-4 w-4 text-destructive" />,
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      {icons[status as keyof typeof icons] ?? icons.pending}
      <span className={status === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{label}</span>
    </div>
  );
}

export function AgentPreviewPanel() {
  const { call } = useApi();
  const { generated, status, setStatus, setIsPolling, setDraftSpec, draftSpec } = useAgentDraftStore();

  // Poll status if generation is in progress
  useQuery({
    queryKey: ['agent-generation-status', generated?.agent_id],
    enabled: Boolean(generated?.agent_id) && status?.status === 'generating',
    refetchInterval: 2000,
    queryFn: async () => {
      const res = await call<{ status: string; steps: GenerationStatus['steps']; agent_preview: unknown }>(
        `/agents/generate/${generated!.agent_id}`,
      );
      setStatus({
        ...status!,
        status: res.status,
        steps: res.steps,
        agent_preview: res.agent_preview,
      });
      if (res.agent_preview) {
        setDraftSpec(res.agent_preview as Parameters<typeof setDraftSpec>[0]);
      }
      if (res.status === 'published' || res.status === 'failed') {
        setIsPolling(false);
      }
      return res;
    },
  });

  if (!generated && !draftSpec) {
    return (
      <Card className="flex min-h-[28rem] flex-col overflow-hidden bg-card/90">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            Agent Preview
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 items-center justify-center">
          <div className="max-w-sm text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
              <Mic2 className="h-7 w-7" />
            </div>
            <p className="font-medium text-foreground">Your generated agent will appear here</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Describe the caller journey, business rules, and integrations, then generate a validated voice-agent spec.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden bg-card/90">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              Agent Preview
            </span>
            {generated && (
              <StatusBadge status={status?.status ?? 'pending'} />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {generated && status && (
            <div className="space-y-3 rounded-2xl border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Generation Progress</p>
              <div className="space-y-1.5">
                <StepStatus label="Spec Generation" status={status.steps.spec_generation.status} />
                <StepStatus label="Document Ingestion" status={status.steps.doc_ingest.status} />
                {status.steps.doc_ingest.total > 0 && (
                  <div className="pl-6">
                    <Progress value={(status.steps.doc_ingest.progress / status.steps.doc_ingest.total) * 100} className="h-1.5" />
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {status.steps.doc_ingest.progress}/{status.steps.doc_ingest.total} chunks processed
                    </p>
                  </div>
                )}
                <StepStatus label="CRM Setup" status={status.steps.crm_setup.status} />
                {status.steps.crm_setup.providers?.length > 0 && (
                  <div className="pl-6 flex gap-1.5 flex-wrap">
                    {status.steps.crm_setup.providers.map(p => <Badge key={p} variant="outline" className="text-xs">{p}</Badge>)}
                  </div>
                )}
                <StepStatus label="Phone Number Assignment" status={status.steps.phone_number.status} />
                {status.steps.phone_number.number && (
                  <p className="pl-6 text-xs text-muted-foreground">{status.steps.phone_number.number}</p>
                )}
                <StepStatus label="Publish" status={status.steps.publish.status} />
              </div>
            </div>
          )}

          {draftSpec ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">Name</p>
                  <p className="font-medium truncate">{(draftSpec as { name?: string }).name ?? '—'}</p>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">Industry</p>
                  <p className="font-medium truncate">{(draftSpec as { industry?: string }).industry ?? '—'}</p>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">Agent Type</p>
                  <p className="font-medium truncate">{(draftSpec as { agent_type?: string }).agent_type ?? '—'}</p>
                </div>
                <div className="rounded-md border border-border bg-background p-3">
                  <p className="text-xs text-muted-foreground">Call Direction</p>
                  <p className="font-medium truncate">{(draftSpec as { call_direction?: string }).call_direction ?? '—'}</p>
                </div>
              </div>
              <details className="rounded-2xl border border-border bg-background">
                <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium hover:bg-muted/50">
                  <FileJson2 className="h-4 w-4 text-primary" />
                  Edit Agent Spec
                </summary>
                <div className="border-t border-border px-3 py-3">
                  <FormModeEditor
                    spec={draftSpec}
                    onChange={setDraftSpec}
                    defaultMode="form"
                  />
                </div>
              </details>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Clock className="h-4 w-4 animate-pulse" />
              Waiting for generation to complete...
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
