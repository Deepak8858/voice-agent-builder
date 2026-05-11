'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { Phone, Plus, Trash2, Link, Unlink } from 'lucide-react';

interface PhoneNumber {
  id: string;
  phoneNumber: string;
  type: string;
  status: string;
  agentId: string | null;
  agent?: { id: string; name: string } | null;
  costPerMonth: number;
  provisionedAt: string | null;
}

interface SessionUser { active_workspace_id: string; }
interface AgentSummary { id: string; name: string; }

export default function PhoneNumbersPage() {
  const { call } = useApi();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [showProvision, setShowProvision] = useState(false);
  const [areaCode, setAreaCode] = useState('');
  const [showByo, setShowByo] = useState(false);
  const [byoNumber, setByoNumber] = useState('');
  const [provisioning, setProvisioning] = useState(false);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch(console.error);
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      call<{ items: PhoneNumber[] }>(`/workspaces/${workspaceId}/phone-numbers`),
      call<{ items: AgentSummary[] }>(`/workspaces/${workspaceId}/agents`),
    ])
      .then(([n, a]) => {
        setNumbers(n.items ?? []);
        setAgents(a.items ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  async function handleProvision(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !areaCode) return;
    setProvisioning(true);
    try {
      await call(`/workspaces/${workspaceId}/phone-numbers/provision`, {
        method: 'POST',
        body: JSON.stringify({ area_code: areaCode }),
      });
      setShowProvision(false);
      setAreaCode('');
      const res = await call<{ items: PhoneNumber[] }>(`/workspaces/${workspaceId}/phone-numbers`);
      setNumbers(res.items ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setProvisioning(false);
    }
  }

  async function handleByo(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !byoNumber) return;
    setProvisioning(true);
    try {
      await call(`/workspaces/${workspaceId}/phone-numbers/byo`, {
        method: 'POST',
        body: JSON.stringify({ phone_number: byoNumber }),
      });
      setShowByo(false);
      setByoNumber('');
      const res = await call<{ items: PhoneNumber[] }>(`/workspaces/${workspaceId}/phone-numbers`);
      setNumbers(res.items ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setProvisioning(false);
    }
  }

  async function handleAssign(numberId: string, agentId: string) {
    await call(`/workspaces/${workspaceId}/phone-numbers/${numberId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ agent_id: agentId }),
    });
    const res = await call<{ items: PhoneNumber[] }>(`/workspaces/${workspaceId}/phone-numbers`);
    setNumbers(res.items ?? []);
  }

  async function handleRelease(numberId: string) {
    if (!confirm('Release this phone number?')) return;
    await call(`/workspaces/${workspaceId}/phone-numbers/${numberId}`, { method: 'DELETE' });
    setNumbers((prev) => prev.filter((n) => n.id !== numberId));
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Phone Numbers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provision Twilio numbers or bring your own. Assign to agents for inbound/outbound calls.
        </p>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

      <div className="flex items-center gap-2">
        <Button onClick={() => setShowProvision(true)} className="gap-1">
          <Plus className="h-4 w-4" /> Provision Number
        </Button>
        <Button variant="outline" onClick={() => setShowByo(true)} className="gap-1">
          <Phone className="h-4 w-4" /> Bring Your Own
        </Button>
      </div>

      {showProvision && (
        <Card>
          <CardHeader><CardTitle>Provision New Number</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleProvision} className="flex items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label>Area Code</Label>
                <Input
                  value={areaCode}
                  onChange={(e) => setAreaCode(e.target.value)}
                  placeholder="415"
                  maxLength={3}
                  className="w-24"
                />
              </div>
              <Button type="submit" disabled={provisioning || areaCode.length !== 3}>
                {provisioning ? 'Provisioning...' : 'Search & Buy'}
              </Button>
              <Button variant="outline" type="button" onClick={() => setShowProvision(false)}>Cancel</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {showByo && (
        <Card>
          <CardHeader><CardTitle>Bring Your Own Number</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleByo} className="flex items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label>Phone Number (E.164)</Label>
                <Input
                  value={byoNumber}
                  onChange={(e) => setByoNumber(e.target.value)}
                  placeholder="+14155551234"
                />
              </div>
              <Button type="submit" disabled={provisioning || !byoNumber}>
                {provisioning ? 'Adding...' : 'Add Number'}
              </Button>
              <Button variant="outline" type="button" onClick={() => setShowByo(false)}>Cancel</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {numbers.length > 0 ? (
        <div className="grid grid-cols-1 gap-3">
          {numbers.map((num) => (
            <Card key={num.id}>
              <CardContent className="flex items-center justify-between py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
                    <Phone className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="font-mono font-medium">{num.phoneNumber}</p>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                      <Badge variant="outline" className="text-xs">{num.type}</Badge>
                      <Badge variant={num.status === 'active' ? 'default' : 'secondary'} className="text-xs">{num.status}</Badge>
                      <span>${Number(num.costPerMonth).toFixed(2)}/mo</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {num.agent ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{num.agent.name}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAssign(num.id, '')}
                        title="Unassign"
                      >
                        <Unlink className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <select
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      onChange={(e) => {
                        if (e.target.value) handleAssign(num.id, e.target.value);
                      }}
                      value=""
                    >
                      <option value="">Unassigned</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name}</option>
                      ))}
                    </select>
                  )}
                  <Button variant="outline" size="sm" onClick={() => handleRelease(num.id)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border p-12 text-center">
          <Phone className="h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">No phone numbers yet. Provision one or bring your own.</p>
        </div>
      )}
    </div>
  );
}