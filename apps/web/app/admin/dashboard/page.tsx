'use client';
import { useEffect, useState } from 'react';

interface OrgSummary {
  org_id: string; org_name: string; plan: string;
  total_spend: number; total_calls: number; total_minutes: number;
}

export default function AdminDashboardPage() {
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/usage/overview')
      .then(r => r.json())
      .then(data => { setOrgs(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-8 animate-pulse">Loading...</div>;

  return (
    <div className="p-8">
      <h1 className="font-[family-name:var(--font-serif)] text-3xl">Ops Dashboard</h1>
      <p className="mt-1 text-sm text-muted-foreground">Organization usage overview</p>
      <div className="mt-6 rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Organization</th>
              <th className="text-left p-3">Plan</th>
              <th className="text-right p-3">Spend</th>
              <th className="text-right p-3">Calls</th>
              <th className="text-right p-3">Minutes</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map(org => (
              <tr key={org.org_id} className="border-t hover:bg-muted/30">
                <td className="p-3">
                  <a href={`/admin/orgs/${org.org_id}/billing`} className="hover:underline">{org.org_name}</a>
                </td>
                <td className="p-3 capitalize">{org.plan}</td>
                <td className="p-3 text-right">${org.total_spend.toFixed(2)}</td>
                <td className="p-3 text-right">{org.total_calls.toLocaleString()}</td>
                <td className="p-3 text-right">{org.total_minutes.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}