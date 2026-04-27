'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  AgentMetricsResponse,
  ComplianceMetrics,
  WorkspaceMetrics,
} from '@voiceforge/shared';
import {
  Badge,
  Card,
  CardHeader,
  CardTitle,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

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
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-sm font-medium text-zinc-500">Last 30 days</h2>
        {overview.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : overview.data ? (
          <KpiGrid m={overview.data} />
        ) : (
          <p className="text-sm text-red-600">Failed to load metrics.</p>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Per-agent performance</CardTitle>
            <Badge>{agents.data?.agents.length ?? 0}</Badge>
          </CardHeader>
          {agents.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : agents.data?.agents.length === 0 ? (
            <p className="text-sm text-zinc-500">No call activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-zinc-500">
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
                      className="border-t border-zinc-200 dark:border-zinc-800"
                    >
                      <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-50">
                        {a.agent_name}
                      </td>
                      <td className="py-2 pr-4">{a.total_calls}</td>
                      <td className="py-2 pr-4">{pct(a.success_rate)}</td>
                      <td className="py-2 pr-4">{pct(a.booking_rate)}</td>
                      <td className="py-2 pr-4">{pct(a.tool_success_rate)}</td>
                      <td className="py-2 pr-4">{a.average_duration_seconds}s</td>
                      <td className="py-2 pr-4">{pct(a.average_evaluation_score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Compliance</CardTitle>
            {compliance.data ? (
              <Badge>{compliance.data.blocked_calls} blocked</Badge>
            ) : null}
          </CardHeader>
          {compliance.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : compliance.data ? (
            <ComplianceSummary m={compliance.data} />
          ) : null}
        </Card>
      </section>

      {overview.data && overview.data.outcomes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Call outcomes</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-1 text-sm">
            {overview.data.outcomes.map((o) => (
              <li
                key={o.outcome}
                className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {o.outcome}
                </span>
                <span className="text-zinc-500">{o.count}</span>
              </li>
            ))}
          </ul>
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
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {value}
      </div>
    </div>
  );
}

function ComplianceSummary({ m }: { m: ComplianceMetrics }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <Kpi label="Opt-outs" value={m.opt_outs.toString()} />
        <Kpi label="DNC hits" value={m.dnc_hits.toString()} />
        <Kpi label="Missing consent" value={m.missing_consent.toString()} />
      </div>
      {m.block_reasons.length > 0 ? (
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500">Top block reasons</div>
          <ul className="flex flex-col gap-1">
            {m.block_reasons.slice(0, 5).map((r) => (
              <li
                key={r.code}
                className="flex items-center justify-between rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-800"
              >
                <span>{r.code}</span>
                <span className="text-zinc-500">{r.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No blocks in this window.</p>
      )}
    </div>
  );
}
