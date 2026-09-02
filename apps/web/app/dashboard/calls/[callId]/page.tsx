import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiCallError, apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CallLiveMonitor } from '@/components/call-live-monitor';
import { PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import type { CallDetail, SessionUser } from '@voiceforge/shared';
import { ArrowLeft, Calendar, Clock3, MapPin, Phone, PlayCircle, User } from 'lucide-react';

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
    /*
     * ph-no-capture on the whole page: the header, stat cards, metadata rows
     * and transcript all render caller names, dialled numbers and call content.
     */
    <div className="ph-no-capture flex flex-col gap-8">
      <PageHeader
        eyebrow="Call detail"
        title={detail.contact_name ?? detail.to_number ?? 'Call'}
        description={`${detail.direction.replace('_', ' ')} · ${detail.provider}`}
        actions={
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link href="/dashboard/calls">
              <ArrowLeft className="h-4 w-4" />
              Calls
            </Link>
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={detail.status} />
          {detail.outcome ? (
            <span className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              {detail.outcome}
            </span>
          ) : null}
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Contact"
          value={detail.contact_name ?? detail.to_number ?? detail.from_number ?? 'Unknown'}
          description="Caller or recipient identifier."
          icon={<User className="h-5 w-5" />}
        />
        <StatCard
          label="Duration"
          value={detail.duration_seconds != null ? `${detail.duration_seconds}s` : '—'}
          description="Measured from provider call metadata."
          icon={<Clock3 className="h-5 w-5" />}
          tone="info"
        />
        <StatCard
          label="Started"
          value={detail.started_at ? new Date(detail.started_at).toLocaleDateString() : '—'}
          description={detail.started_at ? new Date(detail.started_at).toLocaleTimeString() : 'No start time recorded'}
          icon={<Calendar className="h-5 w-5" />}
          tone="warning"
        />
        <StatCard
          label="Turns"
          value={detail.turns.length}
          description="Transcript turns captured for this call."
          icon={<Phone className="h-5 w-5" />}
          tone="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              Live Transcript
            </CardTitle>
            <CardDescription>
              Follow the call in real time and inspect the stored transcript.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CallLiveMonitor
              callId={callId}
              workspaceId={me.active_workspace_id ?? ''}
              initialTurns={detail.turns}
              initialStatus={detail.status}
              fallbackTranscript={detail.transcript_text}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="h-4 w-4 text-primary" />
                Metadata
              </CardTitle>
              <CardDescription>Provider, routing, timing, and call outcome details.</CardDescription>
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
                {detail.carrier_reason ? (
                  <Row label="Carrier reason" value={detail.carrier_reason} />
                ) : null}
                <Row label="Provider" value={detail.provider} />
              </dl>
            </CardContent>
          </Card>

          {detail.recording_url ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <PlayCircle className="h-4 w-4 text-primary" />
                  Recording
                </CardTitle>
                <CardDescription>Audio stored by the telephony provider for this call.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {/* ph-no-capture: the audio is customer speech. The transcript below is
                    the caption track; there is no timed WebVTT for a provider recording. */}
                <audio controls preload="none" src={detail.recording_url} className="ph-no-capture w-full" />
                {/* The URL is provider-hosted, so `download` would be ignored cross-origin
                    and the button would only appear to do nothing. */}
                <Button asChild variant="outline" size="sm" className="w-fit gap-2">
                  <a href={detail.recording_url} target="_blank" rel="noopener noreferrer">
                    Open recording
                  </a>
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {detail.evaluation ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Evaluation</CardTitle>
                <CardDescription>Automated quality score and metric breakdown.</CardDescription>
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
