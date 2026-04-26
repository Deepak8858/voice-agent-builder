import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Badge, Card, CardTitle } from '@/components/ui/primitives';
import type { CallSummary, SessionUser } from '@voiceforge/shared';

export default async function CallsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');
  const { items } = await apiFetch<{ items: CallSummary[] }>(
    `/workspaces/${me.active_workspace_id}/calls`,
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Calls
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          All calls across this workspace. Includes browser tests, inbound, and outbound.
        </p>
      </header>

      <Card>
        <CardTitle>Recent calls ({items.length})</CardTitle>
        {items.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            No calls yet. Open an agent and click <em>Test call</em> to generate one.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
            {items.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <Link
                    className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
                    href={`/dashboard/calls/${c.id}`}
                  >
                    {c.contact_name ?? c.to_number ?? c.from_number ?? 'Unknown contact'}
                  </Link>
                  <p className="text-xs text-zinc-500">
                    {c.direction.replace('_', ' ')} · {c.provider} ·{' '}
                    {new Date(c.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {c.duration_seconds != null ? (
                    <span className="text-xs text-zinc-500">{c.duration_seconds}s</span>
                  ) : null}
                  <Badge>{c.status.replace('_', ' ')}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
