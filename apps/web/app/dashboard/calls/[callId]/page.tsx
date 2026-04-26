import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiCallError, apiFetch } from '@/lib/api';
import { Badge, Card, CardTitle } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import type { CallDetail, SessionUser } from '@voiceforge/shared';

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
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/dashboard/calls"
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            ← Back to calls
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {detail.contact_name ?? detail.to_number ?? 'Call'}
          </h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Badge>{detail.status.replace('_', ' ')}</Badge>
            <span>
              {detail.direction.replace('_', ' ')} · {detail.provider}
            </span>
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardTitle>Transcript</CardTitle>
          {detail.turns.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-2">
              {detail.turns.map((t, idx) => (
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
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              No transcript yet. Real provider transcripts arrive via webhooks.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle>Metadata</CardTitle>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="Agent" value={detail.agent_name ?? detail.agent_id} />
              <Row label="From" value={detail.from_number ?? '—'} />
              <Row label="To" value={detail.to_number ?? '—'} />
              <Row label="Started" value={fmt(detail.started_at)} />
              <Row label="Ended" value={fmt(detail.ended_at)} />
              <Row
                label="Duration"
                value={detail.duration_seconds != null ? `${detail.duration_seconds}s` : '—'}
              />
              <Row label="Outcome" value={detail.outcome ?? '—'} />
              <Row label="Provider" value={detail.provider} />
            </dl>
          </Card>

          {detail.evaluation ? (
            <Card>
              <CardTitle>Evaluation</CardTitle>
              <p className="mt-3 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
                {(detail.evaluation.overall_score * 100).toFixed(0)}%
              </p>
              <p className="mt-1 text-xs text-zinc-500">{detail.evaluation.summary}</p>
              <ul className="mt-3 space-y-1 text-sm">
                {detail.evaluation.metric_scores.map((m) => (
                  <li key={m.name} className="flex items-start justify-between gap-3">
                    <span className="text-xs uppercase tracking-wide text-zinc-500">{m.name}</span>
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">
                      {(m.score * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
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
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-900 dark:text-zinc-50">{value}</dd>
    </div>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
