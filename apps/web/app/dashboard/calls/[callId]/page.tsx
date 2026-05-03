import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiCallError, apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import type { CallDetail, SessionUser } from '@voiceforge/shared';
import { Phone, ArrowLeft, Clock, Calendar, User, MapPin } from 'lucide-react';

interface PageProps {
  params: Promise<{ callId: string }>;
}

export default async function CallDetailPage({ params }: PageProps) {
  const { callId } = await params;
  const me = await apiFetch<SessionUser>('/auth/me');
  let detail: CallDetail;
  try {
    detail = await apiFetch<CallDetail>(
      `/workspaces/${me.active_workspace_id}/calls/${callId}`,
    );
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 404) return notFound();
    throw err;
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href="/dashboard/calls"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to calls
        </Link>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
          {detail.contact_name ?? detail.to_number ?? 'Call'}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant={detail.status === 'completed' ? 'default' : 'secondary'} className="capitalize">
            {detail.status.replace('_', ' ')}
          </Badge>
          <span className="text-sm text-muted-foreground capitalize">
            {detail.direction.replace('_', ' ')} · {detail.provider}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              Transcript
            </CardTitle>
          </CardHeader>
          <CardContent>
            {detail.turns.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {detail.turns.map((t, idx) => (
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
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No transcript yet. Real provider transcripts arrive via webhooks.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary" />
                Metadata
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <Row label="Agent" value={detail.agent_name ?? detail.agent_id} />
                <Row label="From" value={detail.from_number ?? '—'} />
                <Row label="To" value={detail.to_number ?? '—'} />
                <Separator />
                <Row label="Started" value={fmt(detail.started_at)} />
                <Row label="Ended" value={fmt(detail.ended_at)} />
                <Row
                  label="Duration"
                  value={detail.duration_seconds != null ? `${detail.duration_seconds}s` : '—'}
                />
                <Separator />
                <Row label="Outcome" value={detail.outcome ?? '—'} />
                <Row label="Provider" value={detail.provider} />
              </dl>
            </CardContent>
          </Card>

          {detail.evaluation ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Evaluation</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-foreground font-[family-name:var(--font-serif)]">
                  {(detail.evaluation.overall_score * 100).toFixed(0)}%
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{detail.evaluation.summary}</p>
                <ul className="mt-4 space-y-2">
                  {detail.evaluation.metric_scores.map((m) => (
                    <li key={m.name} className="flex items-center justify-between gap-3">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">{m.name}</span>
                      <span className="font-medium text-foreground font-mono">
                        {(m.score * 100).toFixed(0)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
