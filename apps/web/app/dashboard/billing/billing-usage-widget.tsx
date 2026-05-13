'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/use-api';
import { TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UsageData {
  org_id: string;
  period: string;
  total_calls: number;
  total_minutes: number;
  estimated_cost: number;
}

interface TrendsData {
  months: Array<{ period: string; total_calls: number; total_minutes: number }>;
  mom_delta: { calls_pct: number; minutes_pct: number } | null;
}

interface Limits {
  calls: number;
  minutes: number;
}

export function BillingUsageWidget({ orgId }: { orgId: string }) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [limits, setLimits] = useState<Limits>({ calls: 0, minutes: 0 });
  const [trends, setTrends] = useState<TrendsData | null>(null);

  useEffect(() => {
    apiFetch<UsageData>(`/v1/orgs/${orgId}/usage`).then(setUsage).catch(() => {});
    apiFetch<TrendsData>(`/v1/orgs/${orgId}/usage/trends`).then(setTrends).catch(() => {});
    apiFetch<{ limits: Limits }>('/billing/usage').then(r => setLimits(r.limits)).catch(() => {});
  }, [orgId]);

  if (!usage) return <div className="h-24 bg-muted/50 animate-pulse rounded-xl" />;

  const callsPct = limits.calls > 0 ? (usage.total_calls / limits.calls) * 100 : 0;
  const minutesPct = limits.minutes > 0 ? (usage.total_minutes / limits.minutes) * 100 : 0;
  const getColor = (pct: number) => pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-yellow-500' : 'bg-primary';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <UsageBar label="Calls" used={usage.total_calls} limit={limits.calls} pct={callsPct} color={getColor(callsPct)} />
        <UsageBar label="Minutes" used={usage.total_minutes} limit={limits.minutes} pct={minutesPct} color={getColor(minutesPct)} />
        <div className="rounded-xl border bg-card p-4">
          <p className="text-sm text-muted-foreground">Est. cost this month</p>
          <p className="mt-1 text-2xl font-semibold">${usage.estimated_cost.toFixed(2)}</p>
          {trends?.mom_delta && (
            <p className="mt-1 text-xs text-muted-foreground">
              {trends.mom_delta.minutes_pct >= 0 ? '+' : ''}{(trends.mom_delta.minutes_pct * 100).toFixed(0)}% MoM
            </p>
          )}
        </div>
      </div>
      {callsPct > 75 && (
        <div className="rounded-lg border border-chart-2/50 bg-chart-2/10 p-4 flex items-center gap-3">
          <TrendingUp className="h-5 w-5 text-chart-2 shrink-0" />
          <div>
            <p className="font-medium">You&apos;ve used {Math.round(callsPct)}% of your plan</p>
            <p className="text-sm text-muted-foreground">Upgrade to continue without interruption.</p>
          </div>
          <Button size="sm" className="ml-auto shrink-0">Upgrade</Button>
        </div>
      )}
    </div>
  );
}

function UsageBar({ label, used, limit, pct, color }: {
  label: string; used: number; limit: number; pct: number; color: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{limit === -1 ? '∞' : `${used} / ${limit}`}</span>
      </div>
      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{Math.round(pct)}% used</p>
    </div>
  );
}