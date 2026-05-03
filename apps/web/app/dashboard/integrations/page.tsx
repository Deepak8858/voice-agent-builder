import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import type { SessionUser, ToolSummary } from '@voiceforge/shared';
import { Plus, Plug, ArrowRight } from 'lucide-react';

export default async function IntegrationsPage() {
  const me = await apiFetch<SessionUser>('/auth/me');
  const { items } = await apiFetch<{ items: ToolSummary[] }>(
    `/workspaces/${me.active_workspace_id}/tools`,
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Integrations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Webhook tools your agents can call. Each tool fires an outbound HTTP request with
            JSON args.
          </p>
        </div>
        <Link href="/dashboard/integrations/new">
          <Button className="gap-2">
            <Plus className="h-4 w-4" />
            New tool
          </Button>
        </Link>
      </div>

      {items.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent">
            <Plug className="h-7 w-7 text-accent-foreground" />
          </div>
          <div>
            <CardTitle className="text-lg">No tools yet</CardTitle>
            <CardDescription className="max-w-sm mx-auto mt-1">
              Add a webhook tool so your agents can create bookings, update CRM records, or
              trigger any HTTP endpoint mid-call.
            </CardDescription>
          </div>
          <Link href="/dashboard/integrations/new">
            <Button size="lg" className="gap-2 mt-2">
              Create your first tool
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((t) => (
            <Link
              key={t.id}
              href={`/dashboard/integrations/${t.id}`}
              className="group relative rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 hover:border-primary/20"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {t.name}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground capitalize">{t.tool_type}</p>
                </div>
                <Badge variant={t.enabled ? 'default' : 'secondary'} className="shrink-0">
                  {t.enabled ? 'enabled' : 'disabled'}
                </Badge>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
                {t.description}
              </p>
              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Updated {new Date(t.updated_at).toLocaleDateString()}
                </p>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-1" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
