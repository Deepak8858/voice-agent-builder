'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, FormSection, PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
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
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Telephony"
        title="Phone numbers"
        description="Provision Twilio numbers or bring your own, then assign each number to an agent for inbound and outbound calls."
        actions={
          <>
            <Button onClick={() => setShowProvision(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Provision number
            </Button>
            <Button variant="outline" onClick={() => setShowByo(true)} className="gap-2">
              <Phone className="h-4 w-4" />
              Bring your own
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Numbers"
            value={numbers.length}
            description="Configured for this workspace"
            icon={<Phone className="h-5 w-5" />}
          />
          <StatCard
            label="Assigned"
            value={numbers.filter((n) => n.agentId).length}
            description="Linked to active agents"
            icon={<Link className="h-5 w-5" />}
            tone="success"
          />
          <StatCard
            label="Monthly cost"
            value={`$${numbers.reduce((sum, n) => sum + Number(n.costPerMonth), 0).toFixed(2)}`}
            description="Estimated phone number spend"
            tone="info"
          />
        </div>
      </PageHeader>

      {loading && <p className="text-sm text-muted-foreground">Loading...</p>}


      {showProvision && (
        <FormSection
          title="Provision new number"
          description="Search for an available number by area code and add it to the workspace."
        >
            <form onSubmit={handleProvision} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <Label>Area code</Label>
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
        </FormSection>
      )}

      {showByo && (
        <FormSection
          title="Bring your own number"
          description="Connect an existing phone number in E.164 format."
        >
            <form onSubmit={handleByo} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <Label>Phone number (E.164)</Label>
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
        </FormSection>
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
                      <StatusBadge status={num.type} className="text-xs" />
                      <StatusBadge status={num.status} className="text-xs" />
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
        <EmptyState
          icon={<Phone className="h-7 w-7" />}
          title="No phone numbers yet"
          description="Provision a managed number or bring your own number to start routing calls through your agents."
        />
      )}
    </div>
  );
}