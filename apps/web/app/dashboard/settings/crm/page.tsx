'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/use-api';
import { Database, Plus, Trash2, TestTube, CheckCircle, XCircle, ExternalLink } from 'lucide-react';

const CRM_PROVIDERS = [
  { id: 'pipedrive', name: 'Pipedrive', docsUrl: 'https://developers.pipedrive.com' },
  { id: 'hubspot', name: 'HubSpot', docsUrl: 'https://developers.hubspot.com' },
  { id: 'salesforce', name: 'Salesforce', docsUrl: 'https://developer.salesforce.com' },
  { id: 'generic_webhook', name: 'Generic Webhook', docsUrl: '' },
];

interface CrmCredential {
  id: string;
  provider: string;
  status: string;
  lastTestedAt: string | null;
  createdAt: string;
}

interface SessionUser { active_workspace_id: string; }

export default function CrmSettingsPage() {
  const { call } = useApi();
  const searchParams = useSearchParams();
  const defaultTab = searchParams.get('tab') ?? 'credentials';
  const [tab, setTab] = useState(defaultTab);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<CrmCredential[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formProvider, setFormProvider] = useState('');
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch(console.error);
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    call<{ items: CrmCredential[] }>(`/workspaces/${workspaceId}/crm-credentials`)
      .then((res) => setCredentials(res.items ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !formProvider) return;
    setSaving(true);
    try {
      const credentials: Record<string, string> = { api_key: formApiKey };
      if (formBaseUrl) credentials.base_url = formBaseUrl;
      await call(`/workspaces/${workspaceId}/crm-credentials`, {
        method: 'POST',
        body: JSON.stringify({ provider: formProvider, credentials }),
      });
      setShowForm(false);
      setFormProvider('');
      setFormApiKey('');
      setFormBaseUrl('');
      const res = await call<{ items: CrmCredential[] }>(`/workspaces/${workspaceId}/crm-credentials`);
      setCredentials(res.items ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(id: string) {
    await call(`/workspaces/${workspaceId}/crm-credentials/${id}/test`, { method: 'POST' });
    const res = await call<{ items: CrmCredential[] }>(`/workspaces/${workspaceId}/crm-credentials`);
    setCredentials(res.items ?? []);
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this CRM connection?')) return;
    await call(`/workspaces/${workspaceId}/crm-credentials/${id}`, { method: 'DELETE' });
    setCredentials((prev) => prev.filter((c) => c.id !== id));
  }

  const connected = credentials.filter((c) => c.status === 'active');
  const unconfigured = CRM_PROVIDERS.filter((p) => !credentials.some((c) => c.provider === p.id));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">CRM Connections</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your CRM to automatically log call contacts and route leads.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="rules">Routing Rules</TabsTrigger>
        </TabsList>

        <TabsContent value="credentials" className="flex flex-col gap-4">
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}

          {connected.length > 0 && (
            <div className="grid grid-cols-1 gap-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Connected</p>
              {connected.map((cred) => {
                const meta = CRM_PROVIDERS.find((p) => p.id === cred.provider);
                return (
                  <Card key={cred.id}>
                    <CardContent className="flex items-center justify-between py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-green-100">
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        </div>
                        <div>
                          <p className="font-medium">{meta?.name ?? cred.provider}</p>
                          <p className="text-xs text-muted-foreground">
                            Last tested {cred.lastTestedAt ? new Date(cred.lastTestedAt).toLocaleDateString() : 'never'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleTest(cred.id)}>
                          <TestTube className="h-3 w-3" />
                          Test
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleDelete(cred.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          {unconfigured.length > 0 && (
            <div className="grid grid-cols-1 gap-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add Connection</p>
              {unconfigured.map((p) => (
                <Card key={p.id}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                        <Database className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="font-medium">{p.name}</p>
                        {p.docsUrl && (
                          <a href={p.docsUrl} target="_blank" rel="noopener" className="text-xs text-muted-foreground flex items-center gap-1 hover:underline">
                            Docs <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setFormProvider(p.id); setShowForm(true); }}
                    >
                      <Plus className="h-3 w-3" />
                      Connect
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {showForm && (
            <Card>
              <CardHeader>
                <CardTitle>Configure {CRM_PROVIDERS.find((p) => p.id === formProvider)?.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSave} className="flex flex-col gap-4">
                  <div>
                    <Label>API Key</Label>
                    <Input
                      className="mt-1"
                      type="password"
                      value={formApiKey}
                      onChange={(e) => setFormApiKey(e.target.value)}
                      placeholder="pk_xxxx..."
                      required
                    />
                  </div>
                  {formProvider === 'generic_webhook' && (
                    <div>
                      <Label>Webhook URL</Label>
                      <Input
                        className="mt-1"
                        value={formBaseUrl}
                        onChange={(e) => setFormBaseUrl(e.target.value)}
                        placeholder="https://your-webhook.example.com/contacts"
                        required
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Button type="submit" disabled={saving}>
                      {saving ? 'Saving...' : 'Save & Test'}
                    </Button>
                    <Button variant="outline" type="button" onClick={() => setShowForm(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="rules">
          <p className="text-sm text-muted-foreground">
            <a href="/dashboard/settings/crm/rules" className="underline">Open Routing Rules</a> to manage keyword-based CRM routing.
          </p>
        </TabsContent>
      </Tabs>
    </div>
  );
}