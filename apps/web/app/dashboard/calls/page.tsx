import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import type { CallSummary, SessionUser } from '@voiceforge/shared';
import { Phone, ArrowRight } from 'lucide-react';

export default async function CallsPage() {
  let items: CallSummary[] = [];
  let apiError: string | null = null;

  try {
    const me = await apiFetch<SessionUser>('/auth/me');
    const res = await apiFetch<{ items: CallSummary[] }>(
      `/workspaces/${me.active_workspace_id}/calls`,
    );
    items = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError) {
    return (
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Calls</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load calls: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Calls</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All calls across this workspace. Includes browser tests, inbound, and outbound.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent calls ({items.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent">
                <Phone className="h-6 w-6 text-accent-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                No calls yet. Open an agent and click <em>Test call</em> to generate one.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/dashboard/calls/${c.id}`}
                    className="group flex items-center justify-between gap-4 py-4 text-sm transition-colors hover:bg-accent/30 px-2 -mx-2 rounded-lg"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-foreground">
                        {c.contact_name ?? c.to_number ?? c.from_number ?? 'Unknown contact'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        <span className="capitalize">{c.direction.replace('_', ' ')}</span>
                        {' · '}
                        {c.provider}
                        {' · '}
                        {new Date(c.created_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {c.duration_seconds != null ? (
                        <span className="text-xs text-muted-foreground font-mono">
                          {c.duration_seconds}s
                        </span>
                      ) : null}
                      <Badge variant="secondary" className="capitalize">
                        {c.status.replace('_', ' ')}
                      </Badge>
                      <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
