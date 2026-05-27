import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader, StatusBadge } from '@/components/dashboard';
import type { SessionUser, ToolSummary } from '@voiceforge/shared';
import { Plus, Plug, ArrowRight } from 'lucide-react';

export default async function IntegrationsPage() {
  let items: ToolSummary[] = [];
  let apiError: string | null = null;

  try {
    const me = await apiFetch<SessionUser>('/auth/me');
    const res = await apiFetch<{ items: ToolSummary[] }>(
      `/workspaces/${me.active_workspace_id}/tools`,
    );
    items = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Tool calling"
          title="Integrations"
          description={
            <>
              Could not load integrations:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </>
          }
          actions={
            <Button asChild className="gap-2">
              <Link href="/dashboard/integrations/new">
                <Plus className="h-4 w-4" />
                New tool
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Tool calling"
        title="Integrations"
        description="Webhook tools your agents can call during conversations to book appointments, update records, or trigger external workflows."
        actions={
          <Button asChild className="gap-2">
            <Link href="/dashboard/integrations/new">
              <Plus className="h-4 w-4" />
              New tool
            </Link>
          </Button>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<Plug className="h-7 w-7" />}
          title="No tools yet"
          description="Add a webhook tool so your agents can create bookings, update CRM records, or trigger any HTTP endpoint mid-call."
          actionLabel="Create your first tool"
          actionHref="/dashboard/integrations/new"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/integrations/${t.id}`}
              className="group relative rounded-2xl border border-border bg-card/95 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/20 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {t.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground capitalize">{t.tool_type}</p>
                </div>
                <StatusBadge status={t.enabled ? 'enabled' : 'disabled'} className="shrink-0" />
              </div>
              <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted-foreground">
                {t.description}
              </p>
              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(t.updated_at).toLocaleDateString()}
                </p>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all group-hover:translate-x-1 group-hover:opacity-100" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
