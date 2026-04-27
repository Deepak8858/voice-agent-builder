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
  Badge,
  Card,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

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
  const [tab, setTab] = useState<Tab>('contacts');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800 w-fit">
        {(
          [
            { id: 'contacts' as const, label: 'Contacts' },
            { id: 'dnc' as const, label: 'Do Not Call' },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded px-3 py-1 text-xs ${
              tab === t.id
                ? 'bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'contacts' ? (
        <ContactsTab workspaceId={workspaceId} />
      ) : (
        <DncTab workspaceId={workspaceId} />
      )}
    </div>
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Contacts</CardTitle>
          <Badge>{list.data?.items.length ?? 0}</Badge>
        </CardHeader>
        {list.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : list.data?.items.length === 0 ? (
          <p className="text-sm text-zinc-500">No contacts yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.data?.items.map((c) => (
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
                    <div className="font-medium text-zinc-900 dark:text-zinc-50">
                      {c.full_name ?? c.phone}
                    </div>
                    <div className="text-xs text-zinc-500">{c.phone}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {c.opt_out ? (
                      <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        opted out
                      </Badge>
                    ) : null}
                    <Badge>{c.consent_count} consent</Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Add or update contact</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <div>
              <Label>Phone</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 123 4567"
              />
            </div>
            <div>
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div>
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <Button
              type="button"
              onClick={() => create.mutate()}
              disabled={!phone.trim() || create.isPending}
            >
              {create.isPending ? 'Saving…' : 'Save contact'}
            </Button>
          </div>
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

  if (detail.isLoading) return <Card>Loading…</Card>;
  const c = detail.data;
  if (!c) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{c.full_name ?? c.phone}</CardTitle>
        {c.opt_out ? (
          <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            opted out
          </Badge>
        ) : null}
      </CardHeader>
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-zinc-500">{c.phone}</div>

        <div>
          <Label>Consents on file</Label>
          {c.consents.length === 0 ? (
            <p className="text-xs text-zinc-500">None.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs">
              {c.consents.map((cs) => (
                <li
                  key={cs.id}
                  className="flex items-center justify-between rounded border border-zinc-200 px-2 py-1 dark:border-zinc-800"
                >
                  <span>
                    {cs.consent_type} <span className="text-zinc-400">({cs.source})</span>
                  </span>
                  <span className="text-zinc-500">
                    {cs.revoked_at ? 'revoked' : 'active'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2">
          <Select
            value={consentType}
            onChange={(e) =>
              setConsentType(e.target.value as (typeof CONSENT_TYPES)[number])
            }
          >
            {CONSENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            onClick={() => grant.mutate()}
            disabled={grant.isPending}
          >
            Grant
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
          >
            Revoke
          </Button>
        </div>

        {!c.opt_out ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => optOut.mutate()}
            disabled={optOut.isPending}
          >
            Opt this contact out
          </Button>
        ) : (
          <p className="text-xs text-zinc-500">
            Opted out{c.opt_out_reason ? ` — ${c.opt_out_reason}` : ''}
          </p>
        )}
      </div>
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Do Not Call list</CardTitle>
          <Badge>{list.data?.items.length ?? 0}</Badge>
        </CardHeader>
        {list.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : list.data?.items.length === 0 ? (
          <p className="text-sm text-zinc-500">No numbers on the DNC list.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.data?.items.map((e) => (
              <li
                key={e.id}
                className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
              >
                <div>
                  <div className="font-medium text-zinc-900 dark:text-zinc-50">{e.phone}</div>
                  <div className="text-xs text-zinc-500">
                    {e.source}
                    {e.reason ? ` — ${e.reason}` : ''}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => remove.mutate(e.phone)}
                  disabled={remove.isPending}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add to DNC</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label>Phone</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
          <div>
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button
            type="button"
            onClick={() => add.mutate()}
            disabled={!phone.trim() || add.isPending}
          >
            Add
          </Button>
        </div>
      </Card>
    </div>
  );
}
