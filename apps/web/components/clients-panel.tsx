'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ClientInvite,
  ClientUsage,
  ClientWorkspace,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi } from '@/lib/use-api';
import { Building2, Mail, Users, BarChart3 } from 'lucide-react';

interface ClientsPanelProps {
  workspaceId: string;
}

export function ClientsPanel({ workspaceId }: ClientsPanelProps) {
  const { call } = useApi();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('admin');
  const [selected, setSelected] = useState<string | null>(null);

  const clientsKey = ['clients', workspaceId];
  const invitesKey = ['invites', workspaceId];

  const clients = useQuery({
    queryKey: clientsKey,
    queryFn: () =>
      call<{ items: ClientWorkspace[] }>(`/workspaces/${workspaceId}/clients`),
  });

  const invites = useQuery({
    queryKey: invitesKey,
    queryFn: () =>
      call<{ items: ClientInvite[] }>(`/workspaces/${workspaceId}/invites`),
  });

  const createClient = useMutation({
    mutationFn: () =>
      call<ClientWorkspace>(`/workspaces/${workspaceId}/clients`, {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      }),
    onSuccess: () => {
      toast.success('Client workspace created.');
      setName('');
      setSlug('');
      qc.invalidateQueries({ queryKey: clientsKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  const createInvite = useMutation({
    mutationFn: () =>
      call<ClientInvite>(`/workspaces/${workspaceId}/invites`, {
        method: 'POST',
        body: JSON.stringify({
          email,
          role,
          client_workspace_id: selected ?? undefined,
        }),
      }),
    onSuccess: (i) => {
      toast.success('Invite sent.');
      setEmail('');
      navigator.clipboard?.writeText(i.token).catch(() => undefined);
      qc.invalidateQueries({ queryKey: invitesKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) =>
      call<ClientInvite>(`/workspaces/${workspaceId}/invites/${inviteId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      toast.success('Invite revoked.');
      qc.invalidateQueries({ queryKey: invitesKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Client workspaces
            </CardTitle>
            <Badge variant="secondary">{clients.data?.items.length ?? 0}</Badge>
          </CardHeader>
          <CardContent>
            {clients.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : clients.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No client workspaces yet. Create one to start managing agents on their behalf.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {clients.data?.items.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(c.id)}
                      className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left text-sm transition-all hover:bg-accent ${
                        selected === c.id
                          ? 'border-primary bg-accent shadow-sm'
                          : 'border-border bg-background'
                      }`}
                    >
                      <div>
                        <div className="font-medium text-foreground">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.slug}</div>
                      </div>
                      <Badge variant="outline" className="capitalize">{c.status}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selected ? <ClientUsageCard workspaceId={workspaceId} clientId={selected} /> : null}
      </div>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              Add a client
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label>Workspace name</Label>
              <Input className="mt-1.5" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Plumbing" />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                className="mt-1.5"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="acme-plumbing"
              />
            </div>
            <Button
              type="button"
              onClick={() => createClient.mutate()}
              disabled={!name.trim() || !slug.trim() || createClient.isPending}
            >
              {createClient.isPending ? 'Creating…' : 'Create client workspace'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" />
              Invite a client user
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label>Email</Label>
              <Input
                className="mt-1.5"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@acme.com"
              />
            </div>
            <div>
              <Label>Role</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}
              >
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Invite is bound to the selected client workspace
              {selected ? ` (${clients.data?.items.find((c) => c.id === selected)?.name ?? ''})` : ' (select one above)'}.
            </p>
            <Button
              type="button"
              onClick={() => createInvite.mutate()}
              disabled={!email.trim() || !selected || createInvite.isPending}
            >
              {createInvite.isPending ? 'Sending…' : 'Send invite'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              Pending invites
            </CardTitle>
            <Badge variant="secondary">{invites.data?.items.filter((i) => i.status === 'pending').length ?? 0}</Badge>
          </CardHeader>
          <CardContent>
            {invites.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : invites.data?.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invites yet.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {invites.data?.items.map((i) => (
                  <li
                    key={i.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3"
                  >
                    <div>
                      <div className="font-medium text-foreground">{i.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {i.role} · expires {new Date(i.expires_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{i.status}</Badge>
                      {i.status === 'pending' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => revokeInvite.mutate(i.id)}
                          disabled={revokeInvite.isPending}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ClientUsageCard({
  workspaceId,
  clientId,
}: {
  workspaceId: string;
  clientId: string;
}) {
  const { call } = useApi();
  const usage = useQuery({
    queryKey: ['client-usage', workspaceId, clientId],
    queryFn: () =>
      call<ClientUsage>(`/workspaces/${workspaceId}/clients/${clientId}/usage`),
  });

  if (usage.isLoading) {
    return (
      <Card>
        <CardContent className="py-8">
          <p className="text-sm text-muted-foreground">Loading usage…</p>
        </CardContent>
      </Card>
    );
  }
  const u = usage.data;
  if (!u) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          Usage (last 30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Calls" value={u.total_calls.toString()} />
          <Stat label="Minutes" value={u.total_minutes.toFixed(1)} />
          <Stat label="Blocked" value={u.blocked_calls.toString()} />
          <Stat label="Active agents" value={u.active_agents.toString()} />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold text-foreground font-[family-name:var(--font-serif)]">{value}</div>
    </div>
  );
}
