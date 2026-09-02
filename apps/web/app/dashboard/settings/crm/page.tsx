'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useApi } from '@/lib/use-api';
import {
  getConnectionPreset,
  getConnectionPresets,
  type ConnectionProviderId,
} from '@/lib/integration-presets';
import { Database, Plus, Trash2, TestTube, CheckCircle, ExternalLink, Route } from 'lucide-react';

const CRM_PROVIDERS = getConnectionPresets().filter((preset) => preset.category === 'crm');

interface CrmCredential {
  id: string;
  provider: string;
  status: string;
  lastTestedAt: string | null;
  createdAt: string;
}

interface SessionUser { active_workspace_id: string; }

interface RoutingRule {
  id: string;
  keyword: string;
  provider: string;
  action: 'primary' | 'secondary';
  priority: number;
  active: boolean;
}

const RULE_ACTIONS = [
  { value: 'primary', label: 'Primary — create the contact here' },
  { value: 'secondary', label: 'Secondary — mirror the contact here' },
] as const;

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleProvider, setRuleProvider] = useState('');
  const [ruleAction, setRuleAction] = useState<'primary' | 'secondary'>('primary');
  const [savingRule, setSavingRule] = useState(false);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'Could not load your workspace.'),
      );
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    setLoading(true);
    call<{ items: CrmCredential[] }>(`/workspaces/${workspaceId}/crm-credentials`)
      .then((res) => setCredentials(res.items ?? []))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'CRM connections could not be loaded.'),
      )
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  // Routing rules were only reachable through a link to /settings/crm/rules,
  // a route that does not exist — the GET and POST below are the endpoints that
  // link was meant to reach.
  useEffect(() => {
    if (!workspaceId) return;
    setRulesLoading(true);
    call<{ items: RoutingRule[] }>(`/workspaces/${workspaceId}/crm-routing/rules`)
      .then((res) => setRules(res.items ?? []))
      .catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : 'Routing rules could not be loaded.'),
      )
      .finally(() => setRulesLoading(false));
  }, [workspaceId, call]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !formProvider) return;
    setSaving(true);
    setErrorMessage(null);
    try {
      const credentials: Record<string, string> =
        formProvider === 'generic_webhook'
          ? { base_url: formBaseUrl }
          : { api_key: formApiKey };
      if (formBaseUrl && formProvider !== 'generic_webhook') credentials.base_url = formBaseUrl;
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
      setErrorMessage(err instanceof Error ? err.message : 'Connection could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddRule(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !ruleKeyword.trim() || !ruleProvider) return;
    setSavingRule(true);
    try {
      await call(`/workspaces/${workspaceId}/crm-routing/rules`, {
        method: 'POST',
        body: JSON.stringify({
          keyword: ruleKeyword.trim(),
          provider: ruleProvider,
          action: ruleAction,
        }),
      });
      setRuleKeyword('');
      const res = await call<{ items: RoutingRule[] }>(`/workspaces/${workspaceId}/crm-routing/rules`);
      setRules(res.items ?? []);
      toast.success('Routing rule added.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The rule could not be saved.');
    } finally {
      setSavingRule(false);
    }
  }

  async function handleTest(id: string) {
    setErrorMessage(null);
    const result = await call<{ success: boolean; error?: string }>(`/workspaces/${workspaceId}/crm-credentials/${id}/test`, { method: 'POST' });
    if (!result.success && result.error) setErrorMessage(result.error);
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
  const selectedPreset = formProvider ? getConnectionPreset(formProvider as ConnectionProviderId) : null;

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

        {/* ph-no-capture: API tokens and instance URLs are typed here. The
            token input is type="password", but the base URL is not, and
            provider error text can echo credential material back. */}
        <TabsContent value="credentials" className="ph-no-capture flex flex-col gap-4">
          {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
          {errorMessage ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

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
                        <Button asChild variant="outline" size="sm">
                          <a href={meta?.docsUrl ?? '#'} target="_blank" rel="noopener">
                            <ExternalLink className="h-3 w-3" />
                            Docs
                          </a>
                        </Button>
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
                  <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                        <Database className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{p.name}</p>
                          <Badge variant="outline">
                            {p.auth.recommended === 'oauth' ? 'OAuth recommended' : 'Webhook'}
                          </Badge>
                        </div>
                        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                          {p.description} {p.auth.summary}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button asChild variant="outline" size="sm">
                        <a href={p.docsUrl} target="_blank" rel="noopener">
                          <ExternalLink className="h-3 w-3" />
                          Setup guide
                        </a>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setFormProvider(p.id); setShowForm(true); }}
                      >
                        <Plus className="h-3 w-3" />
                        Manual connect
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {showForm && (
            <Card>
              <CardHeader>
                <CardTitle>Configure {selectedPreset?.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSave} className="flex flex-col gap-4">
                  {selectedPreset ? (
                    <div className="rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                      <p className="font-medium text-foreground">{selectedPreset.manualFallback.label}</p>
                      <p className="mt-1">{selectedPreset.manualFallback.summary}</p>
                    </div>
                  ) : null}
                  {formProvider !== 'generic_webhook' && (
                    <div>
                      <Label>
                        {formProvider === 'hubspot'
                          ? 'Private app access token'
                          : formProvider === 'pipedrive'
                            ? 'API token'
                            : 'Access token'}
                      </Label>
                      <Input
                        className="mt-1"
                        type="password"
                        value={formApiKey}
                        onChange={(e) => setFormApiKey(e.target.value)}
                        placeholder={
                          formProvider === 'hubspot'
                            ? 'pat-...'
                            : formProvider === 'pipedrive'
                              ? 'Pipedrive API token'
                              : 'Salesforce bearer token'
                        }
                        required
                      />
                    </div>
                  )}
                  <div>
                    <Label>
                      {formProvider === 'generic_webhook'
                        ? 'Webhook URL'
                        : formProvider === 'salesforce'
                          ? 'Salesforce instance URL'
                          : 'Base URL (optional)'}
                    </Label>
                    <Input
                      className="mt-1"
                      type="url"
                      value={formBaseUrl}
                      onChange={(e) => setFormBaseUrl(e.target.value)}
                      placeholder={
                        formProvider === 'generic_webhook'
                          ? 'https://your-crm.example.com/contacts'
                          : formProvider === 'salesforce'
                            ? 'https://your-domain.my.salesforce.com'
                            : 'https://api.example.com'
                      }
                      required={formProvider === 'generic_webhook' || formProvider === 'salesforce'}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="submit" disabled={saving}>
                      {saving ? 'Saving...' : 'Save connection'}
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

        <TabsContent value="rules" className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Route className="h-4 w-4 text-primary" />
                Keyword routing
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                When a call transcript contains the keyword, the contact is written to the
                matching CRM. A primary rule owns the contact; secondary rules receive a copy.
              </p>

              {rulesLoading ? (
                <p className="text-sm text-muted-foreground">Loading rules...</p>
              ) : rules.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No routing rules yet. Calls are logged without CRM fan-out.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {rules.map((rule) => (
                    <li
                      key={rule.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                    >
                      <span className="font-medium text-foreground">{rule.keyword}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="capitalize">
                          {getConnectionPreset(rule.provider as ConnectionProviderId)?.name ?? rule.provider}
                        </Badge>
                        <Badge variant="outline" className="capitalize">{rule.action}</Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form onSubmit={handleAddRule} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <div>
                  <Label htmlFor="rule-keyword">Keyword</Label>
                  <Input
                    id="rule-keyword"
                    className="mt-1"
                    value={ruleKeyword}
                    onChange={(e) => setRuleKeyword(e.target.value)}
                    placeholder="dental"
                    maxLength={100}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="rule-provider">CRM</Label>
                  <select
                    id="rule-provider"
                    className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={ruleProvider}
                    onChange={(e) => setRuleProvider(e.target.value)}
                    required
                  >
                    <option value="">Select a CRM</option>
                    {CRM_PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="rule-action">Action</Label>
                  <select
                    id="rule-action"
                    className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={ruleAction}
                    onChange={(e) => setRuleAction(e.target.value as 'primary' | 'secondary')}
                  >
                    {RULE_ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </select>
                </div>
                <Button type="submit" disabled={savingRule} className="gap-2">
                  <Plus className="h-4 w-4" />
                  {savingRule ? 'Adding...' : 'Add rule'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
