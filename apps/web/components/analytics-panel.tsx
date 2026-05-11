'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import type {
  AgentMetricsResponse,
  ComplianceMetrics,
  WorkspaceMetrics,
  TimeseriesResponse,
} from '@voiceforge/shared';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { BarChart3, TrendingUp, ShieldCheck, Calendar } from 'lucide-react';
import { useState } from 'react';

interface AnalyticsPanelProps {
  workspaceId: string;
}

// --- date range --------------------------------------------------------

type RangeOption = '7d' | '30d' | '90d';

const RANGE_DAYS: Record<RangeOption, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function buildRangeDays(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function appendQuery(
  path: string,
  query: { from: string; to: string },
): string {
  const params = new URLSearchParams({
    from: query.from,
    to: query.to,
  });
  return `${path}?${params.toString()}`;
}

// --- helpers -----------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// pie slice colours — order matches outcome categories
const OUTCOME_COLORS = [
  '#6366f1', // indigo (completed/success)
  '#22c55e', // green (callback)
  '#f59e0b', // amber (no-answer)
  '#ef4444', // red (failed)
  '#94a3b8', // slate (other)
];

const PIE_AGENTS = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#14b8a6', '#f97316', '#ec4899', '#06b6d4', '#84cc16',
];

export function AnalyticsPanel({ workspaceId }: AnalyticsPanelProps) {
  const { call } = useApi();
  const [range, setRange] = useState<RangeOption>('30d');

  const queryRange = buildRangeDays(RANGE_DAYS[range]);

  const overview = useQuery({
    queryKey: ['analytics', 'workspace', workspaceId, range],
    queryFn: () =>
      call<WorkspaceMetrics>(appendQuery(`/workspaces/${workspaceId}/analytics/workspace`, queryRange)),
  });

  const agents = useQuery({
    queryKey: ['analytics', 'agents', workspaceId, range],
    queryFn: () =>
      call<AgentMetricsResponse>(appendQuery(`/workspaces/${workspaceId}/analytics/agents`, queryRange)),
  });

  const compliance = useQuery({
    queryKey: ['analytics', 'compliance', workspaceId, range],
    queryFn: () =>
      call<ComplianceMetrics>(appendQuery(`/workspaces/${workspaceId}/analytics/compliance`, queryRange)),
  });

  const timeseries = useQuery({
    queryKey: ['analytics', 'timeseries', workspaceId, range],
    queryFn: () =>
      call<TimeseriesResponse>(appendQuery(`/workspaces/${workspaceId}/analytics/timeseries`, queryRange)),
  });

  // derive chart data
  const outcomeData = overview.data?.outcomes.map((o) => ({
    name: o.outcome.replace(/_/g, ' '),
    value: o.count,
  })) ?? [];

  const agentPerfData = (agents.data?.agents ?? []).slice(0, 10).map((a) => ({
    name: a.agent_name.length > 20 ? a.agent_name.slice(0, 18) + '…' : a.agent_name,
    calls: a.total_calls,
    successRate: Math.round(a.success_rate * 100),
    avgDuration: a.average_duration_seconds,
  }));

  const tsData = (timeseries.data?.data ?? []).map((d) => ({
    date: d.date,
    label:
      timeseries.data?.granularity === 'weekly'
        ? d.date
        : d.date.slice(5), // MM-DD for daily
    calls: d.calls,
    success: d.success,
    failed: d.failed,
  }));

  return (
    <div className="flex flex-col gap-8">
      {/* date range selector */}
      <div className="flex items-center gap-3">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <div className="flex gap-1">
          {(['7d', '30d', '90d'] as RangeOption[]).map((opt) => (
            <button
              key={opt}
              onClick={() => setRange(opt)}
              className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                range === opt
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Last {RANGE_DAYS[range]} days
        </h2>
        {overview.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : overview.data ? (
          <KpiGrid m={overview.data} />
        ) : (
          <p className="text-sm text-destructive">Failed to load metrics.</p>
        )}
      </section>

      {/* call volume over time */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Call volume over time
          </CardTitle>
        </CardHeader>
        <CardContent>
          {timeseries.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : tsData.length === 0 ? (
            <p className="text-sm text-muted-foreground">No call data for this period.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={tsData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorCalls" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Legend wrapperStyle={{ fontSize: '12px' }} />
                <Area
                  type="monotone"
                  dataKey="calls"
                  name="Total calls"
                  stroke="#6366f1"
                  strokeWidth={2}
                  fill="url(#colorCalls)"
                />
                <Area
                  type="monotone"
                  dataKey="success"
                  name="Successful"
                  stroke="#22c55e"
                  strokeWidth={2}
                  fill="url(#colorSuccess)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* outcome distribution + agent performance side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* outcome pie */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              Call outcome distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : outcomeData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No outcome data yet.</p>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={outcomeData}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {outcomeData.map((_, i) => (
                        <Cell
                          key={`cell-${i}`}
                          fill={OUTCOME_COLORS[i % OUTCOME_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                  {outcomeData.map((entry, i) => (
                    <div key={entry.name} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }}
                      />
                      <span className="text-muted-foreground">{entry.name}</span>
                      <span className="font-mono font-medium text-foreground">{entry.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* agent performance bar chart */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Agent performance
            </CardTitle>
            <Badge variant="secondary">{agents.data?.agents.length ?? 0} agents</Badge>
          </CardHeader>
          <CardContent>
            {agents.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : agentPerfData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No call activity yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart
                  data={agentPerfData}
                  layout="vertical"
                  margin={{ top: 0, right: 30, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    width={90}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '12px' }} />
                  <Bar dataKey="calls" name="Calls" fill="#6366f1" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="successRate" name="Success %" fill="#22c55e" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* per-agent table (existing, below charts) */}
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
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
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

      {/* call outcomes list */}
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
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Top block reasons
          </div>
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
