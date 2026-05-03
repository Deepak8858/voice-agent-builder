'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ContactDetail,
  ContactSummary,
  DncEntry as DncEntryDto,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/use-api';
import { Users, Phone, ShieldCheck, UserX, CheckCircle, XCircle } from 'lucide-react';

type Tab = 'contacts' | 'dnc';

const CONSENT_TYPES = [
  'outbound_marketing',
  'outbound_transactional',
  'recording',
  'ai_disclosure',
] as const;

interface CompliancePanelProps {
  workspaceId: string;
}

export function CompliancePanel({ workspaceId }: CompliancePanelProps) {
  return (
    <Tabs defaultValue="contacts" className="w-full">
      <TabsList>
        <TabsTrigger value="contacts" className="gap-1.5">
          <Users className="h-3.5 w-3.5" />
          Contacts
        </TabsTrigger>
        <TabsTrigger value="dnc" className="gap-1.5">
          <UserX className="h-3.5 w-3.5" />
          Do Not Call
        </TabsTrigger>
      </TabsList>

      <TabsContent value="contacts" className="mt-6">
        <ContactsTab workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="dnc" className="mt-6">
        <DncTab workspaceId={workspaceId} />
      </TabsContent>
    </Tabs>
  );
}

function ContactsTab({ workspaceId }: { workspaceId: string }) {
  const { call } = useApi();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const listKey = ['contacts', workspaceId];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () =>
      call<{ items: ContactSummary[] }>(`/workspaces/${workspaceId}/contacts`),
  });

  const create = useMutation({
    mutationFn: () =>
      call<ContactDetail>(`/workspaces/${workspaceId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({
          phone,
          full_name: fullName || undefined,
          email: email || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success('Contact saved.');
      setPhone('');
      setFullName('');
      setEmail('');
      qc.invalidateQueries({ queryKey: listKey });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed.'),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Contacts
          </CardTitle>
          <Badge variant="secondary">{list.data?.items.length ?? 0}</Badge>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.data?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.data?.items.map((c) => (
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
                      <div className="font-medium text-foreground">
                        {c.full_name ?? c.phone}
                      </div>
                      <div className="text-xs text-muted-foreground">{c.phone}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {c.opt_out ? (
                        <Badge variant="destructive">opted out</Badge>
                      ) : null}
                      <Badge variant="outline">{c.consent_count} consent</Badge>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              Add or update contact
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Label>Phone</Label>
              <Input
                className="mt-1.5"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
              />
            </div>
            <div>
              <Label>Full name</Label>
              <Input className="mt-1.5" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div>
              <Label>Email</Label>
              <Input className="mt-1.5" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button
              type="button"
              onClick={() => create.mutate()}
              disabled={!phone.trim() || create.isPending}
            >
              {create.isPending ? 'Saving…' : 'Save contact'}
            </Button>
          </CardContent>
        </Card>

        {selected ? <ContactDetailCard workspaceId={workspaceId} contactId={selected} /> : null}
      </div>
    </div>
  );
}

function ContactDetailCard({
  workspaceId,
  contactId,
}: {
  workspaceId: string;
  contactId: string;
}) {
  const { call } = useApi();
  const qc = useQueryClient();
  const [consentType, setConsentType] = useState<(typeof CONSENT_TYPES)[number]>(
    'outbound_transactional',
  );

  const detail = useQuery({
    queryKey: ['contact', workspaceId, contactId],
    queryFn: () =>
      call<ContactDetail>(`/workspaces/${workspaceId}/contacts/${contactId}`),
  });

  const grant = useMutation({
    mutationFn: () =>
      call<ContactDetail>(
        `/workspaces/${workspaceId}/contacts/${contactId}/consent`,
        {
          method: 'POST',
          body: JSON.stringify({ consent_type: consentType, source: 'api' }),
        },
      ),
    onSuccess: () => {
      toast.success('Consent recorded.');
      qc.invalidateQueries({ queryKey: ['contact', workspaceId, contactId] });
      qc.invalidateQueries({ queryKey: ['contacts', workspaceId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  const revoke = useMutation({
    mutationFn: () =>
      call<ContactDetail>(
        `/workspaces/${workspaceId}/contacts/${contactId}/consent/revoke`,
        {
          method: 'POST',
          body: JSON.stringify({ consent_type: consentType }),
        },
      ),
    onSuccess: () => {
      toast.success('Consent revoked.');
      qc.invalidateQueries({ queryKey: ['contact', workspaceId, contactId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  const optOut = useMutation({
    mutationFn: () =>
      call<ContactDetail>(
        `/workspaces/${workspaceId}/contacts/${contactId}/opt-out`,
        { method: 'POST', body: JSON.stringify({ reason: 'manual' }) },
      ),
    onSuccess: () => {
      toast.success('Opted out.');
      qc.invalidateQueries({ queryKey: ['contact', workspaceId, contactId] });
      qc.invalidateQueries({ queryKey: ['contacts', workspaceId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  if (detail.isLoading) return (
    <Card>
      <CardContent className="py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </CardContent>
    </Card>
  );
  const c = detail.data;
  if (!c) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{c.full_name ?? c.phone}</CardTitle>
        {c.opt_out ? <Badge variant="destructive">opted out</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">{c.phone}</p>

        <div>
          <Label className="mb-2 block">Consents on file</Label>
          {c.consents.length === 0 ? (
            <p className="text-xs text-muted-foreground">None.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {c.consents.map((cs) => (
                <li
                  key={cs.id}
                  className="flex items-center justify-between rounded border border-border px-3 py-2"
                >
                  <span className="text-foreground">
                    {cs.consent_type} <span className="text-muted-foreground">({cs.source})</span>
                  </span>
                  <span className="text-muted-foreground">
                    {cs.revoked_at ? 'revoked' : 'active'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2">
          <select
            className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={consentType}
            onChange={(e) => setConsentType(e.target.value as (typeof CONSENT_TYPES)[number])}
          >
            {CONSENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button type="button" onClick={() => grant.mutate()} disabled={grant.isPending} className="gap-1">
            <CheckCircle className="h-3.5 w-3.5" />
            Grant
          </Button>
          <Button type="button" variant="outline" onClick={() => revoke.mutate()} disabled={revoke.isPending} className="gap-1">
            <XCircle className="h-3.5 w-3.5" />
            Revoke
          </Button>
        </div>

        {!c.opt_out ? (
          <Button type="button" variant="outline" onClick={() => optOut.mutate()} disabled={optOut.isPending}>
            Opt this contact out
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            Opted out{c.opt_out_reason ? ` — ${c.opt_out_reason}` : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DncTab({ workspaceId }: { workspaceId: string }) {
  const { call } = useApi();
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');

  const list = useQuery({
    queryKey: ['dnc', workspaceId],
    queryFn: () =>
      call<{ items: DncEntryDto[] }>(`/workspaces/${workspaceId}/compliance/dnc`),
  });

  const add = useMutation({
    mutationFn: () =>
      call<DncEntryDto>(`/workspaces/${workspaceId}/compliance/dnc`, {
        method: 'POST',
        body: JSON.stringify({
          phone,
          source: 'manual',
          reason: reason || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success('Added to DNC.');
      setPhone('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['dnc', workspaceId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  const remove = useMutation({
    mutationFn: (p: string) =>
      call<void>(
        `/workspaces/${workspaceId}/compliance/dnc/${encodeURIComponent(p)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      toast.success('Removed.');
      qc.invalidateQueries({ queryKey: ['dnc', workspaceId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed.'),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Do Not Call list
          </CardTitle>
          <Badge variant="secondary">{list.data?.items.length ?? 0}</Badge>
        </CardHeader>
        <CardContent>
          {list.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : list.data?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No numbers on the DNC list.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.data?.items.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 text-sm"
                >
                  <div>
                    <div className="font-medium text-foreground">{e.phone}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.source}
                      {e.reason ? ` — ${e.reason}` : ''}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate(e.phone)}
                    disabled={remove.isPending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserX className="h-4 w-4 text-primary" />
            Add to DNC
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Label>Phone</Label>
            <Input
              className="mt-1.5"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
          <div>
            <Label>Reason</Label>
            <Input className="mt-1.5" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button
            type="button"
            onClick={() => add.mutate()}
            disabled={!phone.trim() || add.isPending}
          >
            Add
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
