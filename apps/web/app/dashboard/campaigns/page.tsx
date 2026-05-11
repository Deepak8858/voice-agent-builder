'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { Megaphone, Plus, Pause, Play, BarChart3 } from 'lucide-react';

interface Campaign {
  id: string;
  name: string;
  status: string;
  stats: { total: number; completed: number; failed: number; in_progress: number };
  agent: { id: string; name: string } | null;
  createdAt: string;
}

interface SessionUser { active_workspace_id: string; }
interface AgentSummary { id: string; name: string; }

export default function CampaignsPage() {
  const { call } = useApi();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState('');
  const [formAgent, setFormAgent] = useState('');
  const [formContacts, setFormContacts] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch(console.error);
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`),
      call<{ items: AgentSummary[] }>(`/workspaces/${workspaceId}/agents`),
    ])
      .then(([c, a]) => {
        setCampaigns(c.items ?? []);
        setAgents(a.items ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !formName || !formAgent) return;
    setCreating(true);
    try {
      const lines = formContacts.trim().split('\n');
      const contacts = lines
        .filter((l) => l.trim())
        .map((l) => {
          const [phone, ...rest] = l.split(',');
          const name = rest.join(',').trim();
          return { phone: phone.trim(), full_name: name || undefined };
        });
      await call(`/workspaces/${workspaceId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({ name: formName, agent_id: formAgent, contacts }),
      });
      setShowCreate(false);
      setFormName('');
      setFormAgent('');
      setFormContacts('');
      const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
      setCampaigns(res.items ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }

  async function handleStart(id: string) {
    await call(`/workspaces/${workspaceId}/campaigns/${id}/start`, { method: 'POST' });
    const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
    setCampaigns(res.items ?? []);
  }

  async function handlePause(id: string) {
    await call(`/workspaces/${workspaceId}/campaigns/${id}/pause`, { method: 'PATCH' });
    const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
    setCampaigns(res.items ?? []);
  }

  const statusColor = (s: string) =>
    s === 'running' ? 'default' : s === 'draft' ? 'secondary' : 'outline';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Outbound Campaigns</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Schedule and run bulk outbound calling campaigns with your voice agents.
        </p>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      <Button onClick={() => setShowCreate(true)} className="w-fit gap-1">
        <Plus className="h-4 w-4" /> New Campaign
      </Button>

      {showCreate && (
        <Card>
          <CardHeader><CardTitle>New Campaign</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Campaign Name</Label>
                  <Input
                    className="mt-1"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    placeholder="Q2 Patient Recall"
                    required
                  />
                </div>
                <div>
                  <Label>Agent</Label>
                  <select
                    className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formAgent}
                    onChange={(e) => setFormAgent(e.target.value)}
                    required
                  >
                    <option value="">Select agent...</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <Label>Contacts (one per line: phone[, name])</Label>
                <textarea
                  className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  rows={5}
                  value={formContacts}
                  onChange={(e) => setFormContacts(e.target.value)}
                  placeholder={"+14155551111, John Doe\n+14155552222"}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create Campaign'}</Button>
                <Button variant="outline" type="button" onClick={() => setShowCreate(false)}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {campaigns.length > 0 ? (
        <div className="grid grid-cols-1 gap-4">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <Megaphone className="h-5 w-5 text-primary" />
                    <div>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {c.agent ? `Agent: ${c.agent.name}` : 'No agent'} · Created {new Date(c.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusColor(c.status) as 'default' | 'secondary' | 'outline'}>{c.status}</Badge>
                    {c.status === 'draft' || c.status === 'paused' ? (
                      <Button size="sm" onClick={() => handleStart(c.id)}>
                        <Play className="h-3 w-3" /> Start
                      </Button>
                    ) : c.status === 'running' ? (
                      <Button size="sm" variant="outline" onClick={() => handlePause(c.id)}>
                        <Pause className="h-3 w-3" /> Pause
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-4 text-center">
                  {[
                    { label: 'Total', value: c.stats.total },
                    { label: 'Completed', value: c.stats.completed },
                    { label: 'Failed', value: c.stats.failed },
                    { label: 'In Progress', value: c.stats.in_progress },
                  ].map((s) => (
                    <div key={s.label} className="rounded-md bg-muted/50 p-2">
                      <p className="text-lg font-semibold">{s.value}</p>
                      <p className="text-xs text-muted-foreground">{s.label}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
          <Megaphone className="h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No campaigns yet. Create one to start outbound calling.</p>
        </div>
      )}
    </div>
  );
}