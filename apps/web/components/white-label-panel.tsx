'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { WhiteLabelSettings } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useApi } from '@/lib/use-api';
import { Palette, Save, Eye } from 'lucide-react';

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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-primary" />
            Branding
          </CardTitle>
        </CardHeader>
        <CardContent>
          {settings.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <Label>Brand name</Label>
                <Input className="mt-1.5" value={form.brand_name} onChange={onChange('brand_name')} placeholder="Agency Voice AI" />
              </div>
              <div>
                <Label>Logo URL</Label>
                <Input className="mt-1.5" value={form.logo_url} onChange={onChange('logo_url')} placeholder="https://cdn.example.com/logo.svg" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Primary color</Label>
                  <Input
                    className="mt-1.5"
                    value={form.primary_color}
                    onChange={onChange('primary_color')}
                    placeholder="#111827"
                  />
                </div>
                <div>
                  <Label>Support email</Label>
                  <Input
                    className="mt-1.5"
                    value={form.support_email}
                    onChange={onChange('support_email')}
                    placeholder="support@agency.com"
                  />
                </div>
              </div>
              <div>
                <Label>Custom domain</Label>
                <Input
                  className="mt-1.5"
                  value={form.custom_domain}
                  onChange={onChange('custom_domain')}
                  placeholder="voice.agency.com"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  DNS + TLS provisioning is handled outside this dashboard for now.
                </p>
              </div>
              <div className="flex items-center gap-3 py-2">
                <Switch
                  id="hide-branding"
                  checked={form.hide_platform_branding}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({ ...f, hide_platform_branding: checked }))
                  }
                />
                <Label htmlFor="hide-branding" className="cursor-pointer">
                  Hide VoiceForge branding from client-facing pages
                </Label>
              </div>
              <div className="flex justify-end pt-2">
                <Button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="gap-2">
                  <Save className="h-4 w-4" />
                  {save.isPending ? 'Saving…' : 'Save branding'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            Preview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="flex items-center gap-3 rounded-lg border border-border bg-background p-4"
            style={form.primary_color ? { borderColor: form.primary_color } : undefined}
          >
            <div
              className="flex h-10 w-10 items-center justify-center rounded-md text-sm font-bold text-white"
              style={{ background: form.primary_color || '#111827' }}
            >
              {(form.brand_name || 'V').slice(0, 1).toUpperCase()}
            </div>
            <div className="text-sm">
              <div className="font-medium text-foreground">
                {form.brand_name || 'Your brand'}
              </div>
              <div className="text-xs text-muted-foreground">
                {form.support_email || 'support@example.com'}
              </div>
            </div>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Last saved:{' '}
            {settings.data?.updated_at && settings.data.updated_at !== new Date(0).toISOString()
              ? new Date(settings.data.updated_at).toLocaleString()
              : 'never'}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
