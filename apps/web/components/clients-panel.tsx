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
  Badge,
  Card,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Client workspaces</CardTitle>
            <Badge>{clients.data?.items.length ?? 0}</Badge>
          </CardHeader>
          {clients.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : clients.data?.items.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No client workspaces yet. Create one to start managing agents on their behalf.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {clients.data?.items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900 ${
                      selected === c.id
                        ? 'border-zinc-900 dark:border-zinc-100'
                        : 'border-zinc-200 dark:border-zinc-800'
                    }`}
                  >
                    <div>
                      <div className="font-medium text-zinc-900 dark:text-zinc-50">{c.name}</div>
                      <div className="text-xs text-zinc-500">{c.slug}</div>
                    </div>
                    <Badge>{c.status}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {selected ? <ClientUsageCard workspaceId={workspaceId} clientId={selected} /> : null}
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Add a client</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label>Workspace name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Plumbing" />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
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
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invite a client user</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label>Email</Label>
              <Input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@acme.com"
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}>
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </Select>
            </div>
            <p className="text-xs text-zinc-500">
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
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
            <Badge>{invites.data?.items.filter((i) => i.status === 'pending').length ?? 0}</Badge>
          </CardHeader>
          {invites.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : invites.data?.items.length === 0 ? (
            <p className="text-sm text-zinc-500">No invites yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {invites.data?.items.map((i) => (
                <li
                  key={i.id}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <div>
                    <div className="font-medium text-zinc-900 dark:text-zinc-50">{i.email}</div>
                    <div className="text-xs text-zinc-500">
                      {i.role} · expires {new Date(i.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge>{i.status}</Badge>
                    {i.status === 'pending' ? (
                      <Button
                        type="button"
                        variant="ghost"
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
        <p className="text-sm text-zinc-500">Loading usage…</p>
      </Card>
    );
  }
  const u = usage.data;
  if (!u) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage (last 30 days)</CardTitle>
      </CardHeader>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Calls" value={u.total_calls.toString()} />
        <Stat label="Minutes" value={u.total_minutes.toFixed(1)} />
        <Stat label="Blocked" value={u.blocked_calls.toString()} />
        <Stat label="Active agents" value={u.active_agents.toString()} />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{value}</div>
    </div>
  );
}
