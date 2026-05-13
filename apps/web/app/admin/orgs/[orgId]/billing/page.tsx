'use client';
import { useEffect, useState, use } from 'react';

interface OrgUsage {
  org_id: string; period: string; total_spend: number;
  total_calls: number; total_minutes: number; active_workspaces: number;
}

interface AgentUsage {
  agent_id: string; agent_name: string;
  total_calls: number; total_minutes: number; estimated_cost: number;
}

export default function OrgBillingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [agents, setAgents] = useState<AgentUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(`/api/admin/orgs/${orgId}/usage`).then(r => r.json()),
      fetch(`/api/admin/orgs/${orgId}/agents/usage`).then(r => r.json()),
    ]).then(([u, a]) => { setUsage(u); setAgents(a); setLoading(false); });
  }, [orgId]);

  if (loading) return <div className="p-8 animate-pulse">Loading...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">Org Billing</h1>
      <p className="mt-1 text-sm text-muted-foreground">{orgId} — {usage?.period}</p>
      {usage && (
        <div className="mt-6 grid grid-cols-4 gap-4">
          <MetricCard label="Spend" value={`$${usage.total_spend.toFixed(2)}`} />
          <MetricCard label="Calls" value={usage.total_calls.toLocaleString()} />
          <MetricCard label="Minutes" value={usage.total_minutes.toLocaleString()} />
          <MetricCard label="Workspaces" value={usage.active_workspaces.toString()} />
        </div>
      )}
      <h2 className="mt-8 text-xl font-semibold">Per-Agent Breakdown</h2>
      <div className="mt-4 rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Agent</th>
              <th className="text-right p-3">Calls</th>
              <th className="text-right p-3">Minutes</th>
              <th className="text-right p-3">Est. Cost</th>
            </tr>
          </thead>
          <tbody>
            {agents.map(agent => (
              <tr key={agent.agent_id} className="border-t">
                <td className="p-3">{agent.agent_name}</td>
                <td className="p-3 text-right">{agent.total_calls.toLocaleString()}</td>
                <td className="p-3 text-right">{agent.total_minutes.toLocaleString()}</td>
                <td className="p-3 text-right">${agent.estimated_cost.toFixed(2)}</td>
              </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}