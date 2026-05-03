'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AgentMetricsResponse,
  ComplianceMetrics,
  WorkspaceMetrics,
} from '@voiceforge/shared';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { BarChart3, TrendingUp, ShieldCheck } from 'lucide-react';

interface AnalyticsPanelProps {
  workspaceId: string;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function AnalyticsPanel({ workspaceId }: AnalyticsPanelProps) {
  const { call } = useApi();

  const overview = useQuery({
    queryKey: ['analytics', 'workspace', workspaceId],
    queryFn: () =>
      call<WorkspaceMetrics>(`/workspaces/${workspaceId}/analytics/workspace`),
  });

  const agents = useQuery({
    queryKey: ['analytics', 'agents', workspaceId],
    queryFn: () =>
      call<AgentMetricsResponse>(`/workspaces/${workspaceId}/analytics/agents`),
  });

  const compliance = useQuery({
    queryKey: ['analytics', 'compliance', workspaceId],
    queryFn: () =>
      call<ComplianceMetrics>(`/workspaces/${workspaceId}/analytics/compliance`),
  });

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-4 text-sm font-medium text-muted-foreground uppercase tracking-wider">Last 30 days</h2>
        {overview.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : overview.data ? (
          <KpiGrid m={overview.data} />
        ) : (
          <p className="text-sm text-destructive">Failed to load metrics.</p>
        )}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Per-agent performance
            </CardTitle>
            <Badge variant="secondary">{agents.data?.agents.length ?? 0}</Badge>
          </CardHeader>
          <CardContent>
            {agents.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : agents.data?.agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No call activity yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4">Agent</th>
                      <th className="py-2 pr-4">Calls</th>
                      <th className="py-2 pr-4">Success</th>
                      <th className="py-2 pr-4">Booked</th>
                      <th className="py-2 pr-4">Tool ok</th>
                      <th className="py-2 pr-4">Avg dur</th>
                      <th className="py-2 pr-4">Eval</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.data?.agents.map((a) => (
                      <tr
                        key={a.agent_id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="py-2 pr-4 font-medium text-foreground">
                          {a.agent_name}
                        </td>
                        <td className="py-2 pr-4 font-mono">{a.total_calls}</td>
                        <td className="py-2 pr-4 font-mono">{pct(a.success_rate)}</td>
                        <td className="py-2 pr-4 font-mono">{pct(a.booking_rate)}</td>
                        <td className="py-2 pr-4 font-mono">{pct(a.tool_success_rate)}</td>
                        <td className="py-2 pr-4 font-mono">{a.average_duration_seconds}s</td>
                        <td className="py-2 pr-4 font-mono">{pct(a.average_evaluation_score)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Compliance
            </CardTitle>
            {compliance.data ? (
              <Badge variant="secondary">{compliance.data.blocked_calls} blocked</Badge>
            ) : null}
          </CardHeader>
          <CardContent>
            {compliance.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : compliance.data ? (
              <ComplianceSummary m={compliance.data} />
            ) : null}
          </CardContent>
        </Card>
      </section>

      {overview.data && overview.data.outcomes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Call outcomes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1 text-sm">
              {overview.data.outcomes.map((o) => (
                <li
                  key={o.outcome}
                  className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2"
                >
                  <span className="font-medium text-foreground">{o.outcome}</span>
                  <span className="text-muted-foreground font-mono">{o.count}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function KpiGrid({ m }: { m: WorkspaceMetrics }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      <Kpi label="Total calls" value={m.total_calls.toString()} />
      <Kpi label="Total minutes" value={m.total_minutes.toFixed(1)} />
      <Kpi label="Success rate" value={pct(m.success_rate)} />
      <Kpi label="Answer rate" value={pct(m.answer_rate)} />
      <Kpi label="Failed rate" value={pct(m.failed_call_rate)} />
      <Kpi label="Blocked" value={m.blocked_calls.toString()} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground font-[family-name:var(--font-serif)]">
        {value}
      </div>
    </div>
  );
}

function ComplianceSummary({ m }: { m: ComplianceMetrics }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <Kpi label="Opt-outs" value={m.opt_outs.toString()} />
        <Kpi label="DNC hits" value={m.dnc_hits.toString()} />
        <Kpi label="Missing consent" value={m.missing_consent.toString()} />
      </div>
      {m.block_reasons.length > 0 ? (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">Top block reasons</div>
          <ul className="flex flex-col gap-1">
            {m.block_reasons.slice(0, 5).map((r) => (
              <li
                key={r.code}
                className="flex items-center justify-between rounded border border-border px-2 py-1.5 text-xs"
              >
                <span className="text-foreground">{r.code}</span>
                <span className="text-muted-foreground font-mono">{r.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No blocks in this window.</p>
      )}
    </div>
  );
}
