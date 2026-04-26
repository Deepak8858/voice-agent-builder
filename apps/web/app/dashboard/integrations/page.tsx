import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardTitle } from '@/components/ui/primitives';
import type { SessionUser, ToolSummary } from '@voiceforge/shared';

export default async function IntegrationsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');
  const { items } = await apiFetch<{ items: ToolSummary[] }>(
    `/workspaces/${me.active_workspace_id}/tools`,
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Integrations
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Webhook tools your agents can call. Each tool fires an outbound HTTP request with
            JSON args.
          </p>
        </div>
        <Link href="/dashboard/integrations/new">
          <Button>+ New tool</Button>
        </Link>
      </header>

      {items.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <CardTitle>No tools yet</CardTitle>
          <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            Add a webhook tool so your agents can create bookings, update CRM records, or
            trigger any HTTP endpoint mid-call.
          </p>
          <Link href="/dashboard/integrations/new">
            <Button size="lg">Create your first tool</Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/integrations/${t.id}`}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-300 hover:shadow-md dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                    {t.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-500">{t.tool_type}</p>
                </div>
                <Badge>{t.enabled ? 'enabled' : 'disabled'}</Badge>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                {t.description}
              </p>
              <p className="mt-4 text-xs text-zinc-500">
                Updated {new Date(t.updated_at).toLocaleDateString()}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
