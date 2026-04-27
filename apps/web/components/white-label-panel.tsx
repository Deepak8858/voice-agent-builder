'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { WhiteLabelSettings } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, Input, Label } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface WhiteLabelPanelProps {
  workspaceId: string;
}

interface FormState {
  brand_name: string;
  logo_url: string;
  primary_color: string;
  custom_domain: string;
  support_email: string;
  hide_platform_branding: boolean;
}

const EMPTY_FORM: FormState = {
  brand_name: '',
  logo_url: '',
  primary_color: '',
  custom_domain: '',
  support_email: '',
  hide_platform_branding: false,
};

function toForm(s: WhiteLabelSettings | undefined): FormState {
  if (!s) return EMPTY_FORM;
  return {
    brand_name: s.brand_name ?? '',
    logo_url: s.logo_url ?? '',
    primary_color: s.primary_color ?? '',
    custom_domain: s.custom_domain ?? '',
    support_email: s.support_email ?? '',
    hide_platform_branding: s.hide_platform_branding,
  };
}

export function WhiteLabelPanel({ workspaceId }: WhiteLabelPanelProps) {
  const { call } = useApi();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const settings = useQuery({
    queryKey: ['white-label', workspaceId],
    queryFn: () =>
      call<WhiteLabelSettings>(`/workspaces/${workspaceId}/white-label`),
  });

  useEffect(() => {
    if (settings.data) setForm(toForm(settings.data));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () =>
      call<WhiteLabelSettings>(`/workspaces/${workspaceId}/white-label`, {
        method: 'PATCH',
        body: JSON.stringify({
          brand_name: form.brand_name || null,
          logo_url: form.logo_url || null,
          primary_color: form.primary_color || null,
          custom_domain: form.custom_domain || null,
          support_email: form.support_email || null,
          hide_platform_branding: form.hide_platform_branding,
        }),
      }),
    onSuccess: () => {
      toast.success('Branding saved.');
      qc.invalidateQueries({ queryKey: ['white-label', workspaceId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed.'),
  });

  const onChange =
    <K extends keyof FormState>(key: K) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({
        ...f,
        [key]: key === 'hide_platform_branding' ? e.target.checked : e.target.value,
      }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
        </CardHeader>
        {settings.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <Label>Brand name</Label>
              <Input value={form.brand_name} onChange={onChange('brand_name')} placeholder="Agency Voice AI" />
            </div>
            <div>
              <Label>Logo URL</Label>
              <Input value={form.logo_url} onChange={onChange('logo_url')} placeholder="https://cdn.example.com/logo.svg" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Primary color</Label>
                <Input
                  value={form.primary_color}
                  onChange={onChange('primary_color')}
                  placeholder="#111827"
                />
              </div>
              <div>
                <Label>Support email</Label>
                <Input
                  value={form.support_email}
                  onChange={onChange('support_email')}
                  placeholder="support@agency.com"
                />
              </div>
            </div>
            <div>
              <Label>Custom domain</Label>
              <Input
                value={form.custom_domain}
                onChange={onChange('custom_domain')}
                placeholder="voice.agency.com"
              />
              <p className="mt-1 text-xs text-zinc-500">
                DNS + TLS provisioning is handled outside this dashboard for now.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={form.hide_platform_branding}
                onChange={onChange('hide_platform_branding')}
              />
              Hide VoiceForge branding from client-facing pages
            </label>
            <div className="flex justify-end">
              <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save branding'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <div
          className="flex items-center gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
          style={form.primary_color ? { borderColor: form.primary_color } : undefined}
        >
          <div
            className="flex h-10 w-10 items-center justify-center rounded-md text-sm font-bold text-white"
            style={{ background: form.primary_color || '#111827' }}
          >
            {(form.brand_name || 'V').slice(0, 1).toUpperCase()}
          </div>
          <div className="text-sm">
            <div className="font-medium text-zinc-900 dark:text-zinc-50">
              {form.brand_name || 'Your brand'}
            </div>
            <div className="text-xs text-zinc-500">
              {form.support_email || 'support@example.com'}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Last saved:{' '}
          {settings.data?.updated_at && settings.data.updated_at !== new Date(0).toISOString()
            ? new Date(settings.data.updated_at).toLocaleString()
            : 'never'}
        </p>
      </Card>
    </div>
  );
}
