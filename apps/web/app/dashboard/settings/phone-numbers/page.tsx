'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SyncedProviderPhoneNumber } from '@voiceforge/shared';
import { UpgradeModal } from '@/components/upgrade-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, FormSection, PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import { getPlanLimitRedirect, type PlanLimitRedirect } from '@/lib/plan-limit';
import { useApi } from '@/lib/use-api';
import {
  CheckCircle2,
  KeyRound,
  Link,
  Phone,
  PlugZap,
  RefreshCw,
  Router,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

type Provider = 'twilio' | 'vobiz' | 'sip';

interface SessionUser {
  active_workspace_id: string;
}

interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

interface TelephonyConnection {
  id: string;
  provider: Provider;
  display_name: string;
  provider_account_id: string | null;
  status: string;
  last_sync_at: string | null;
}

type ProviderNumber = SyncedProviderPhoneNumber;

interface PhoneNumber {
  id: string;
  provider: Provider;
  provider_connection_id: string | null;
  phone_number: string;
  friendly_name: string | null;
  status: string;
  assigned_agent_id: string | null;
  agent?: { id: string; name: string } | null;
  inbound_enabled: boolean;
  outbound_enabled: boolean;
  livekit: {
    status: string;
    sip_host: string;
    inbound_trunk_id: string | null;
    outbound_trunk_id: string | null;
    dispatch_rule_id: string | null;
  } | null;
  provider_connection?: { id: string; displayName: string; status: string } | null;
  carrier_setup: {
    inbound_sip_uri: string;
    auth_username: string | null;
    outbound_sip_domain: string | null;
    ip_allowlist_hint: string;
  } | null;
  last_synced_at: string | null;
  created_at: string;
}

interface ConnectForm {
  provider: Provider;
  displayName: string;
  accountSid: string;
  authToken: string;
  vobizAuthId: string;
  vobizAuthToken: string;
  vobizCustomerAuthId: string;
}

const emptyConnectForm: ConnectForm = {
  provider: 'twilio',
  displayName: '',
  accountSid: '',
  authToken: '',
  vobizAuthId: '',
  vobizAuthToken: '',
  vobizCustomerAuthId: '',
};

interface SipForm {
  phoneNumber: string;
  sipTrunkDomain: string;
  sipAuthUsername: string;
  sipAuthPassword: string;
}

const emptySipForm: SipForm = {
  phoneNumber: '',
  sipTrunkDomain: '',
  sipAuthUsername: '',
  sipAuthPassword: '',
};

// Two newlines: the provider's message, then the steps it wants done by hand.
const SECTION_BREAK = '\n\n';

const E164_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

export default function PhoneNumbersPage() {
  const router = useRouter();
  const { call } = useApi();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [connections, setConnections] = useState<TelephonyConnection[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumber[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [providerNumbers, setProviderNumbers] = useState<ProviderNumber[]>([]);
  const [selectedProviderNumbers, setSelectedProviderNumbers] = useState<Set<string>>(new Set());
  const [phoneNumberOverrides, setPhoneNumberOverrides] = useState<Record<string, string>>({});
  const [sipDomainOverrides, setSipDomainOverrides] = useState<Record<string, string>>({});
  const [importWebhookSecret, setImportWebhookSecret] = useState('');
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [connectForm, setConnectForm] = useState<ConnectForm>(emptyConnectForm);
  const [sipForm, setSipForm] = useState<SipForm>(emptySipForm);
  const [panel, setPanel] = useState<'connect' | 'sip' | null>(null);
  // What a provider could not configure for us, keyed by number. The API returns
  // it once, from configure; throwing it away left Vobiz users with a number
  // that looked ready and a trunk nobody had pointed anywhere.
  const [manualSteps, setManualSteps] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planLimit, setPlanLimit] = useState<PlanLimitRedirect | null>(null);

  const handleApiError = useCallback((err: unknown, fallbackMessage: string) => {
    const redirect = getPlanLimitRedirect(err);
    if (redirect) {
      setPlanLimit(redirect);
      setError(redirect.message);
      return;
    }
    setError(err instanceof Error ? err.message : fallbackMessage);
  }, []);

  const refresh = useCallback(async (activeWorkspaceId = workspaceId) => {
    if (!activeWorkspaceId) return;
    setLoading(true);
    try {
      const [connectionRes, numberRes, agentRes] = await Promise.all([
        call<{ items: TelephonyConnection[] }>(`/workspaces/${activeWorkspaceId}/telephony/connections`),
        call<{ items: PhoneNumber[] }>(`/workspaces/${activeWorkspaceId}/telephony/phone-numbers`),
        call<{ items: AgentSummary[] }>(`/workspaces/${activeWorkspaceId}/agents`),
      ]);
      setConnections(connectionRes.items ?? []);
      setNumbers(numberRes.items ?? []);
      setAgents(agentRes.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [call, workspaceId]);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load session'));
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    const loadTimer = window.setTimeout(() => {
      refresh(workspaceId).catch((err) => setError(err instanceof Error ? err.message : 'Could not load phone numbers'));
    }, 0);
    return () => window.clearTimeout(loadTimer);
  }, [refresh, workspaceId]);

  const stats = useMemo(() => {
    const livekitReady = numbers.filter((number) => number.livekit?.status === 'configured').length;
    const assigned = numbers.filter((number) => number.assigned_agent_id).length;
    const pending = numbers.filter((number) => number.status === 'pending_verification').length;
    return { livekitReady, assigned, pending };
  }, [numbers]);

  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );

  async function createConnection(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setBusy('connect');
    setError(null);
    try {
      const credentials =
        connectForm.provider === 'twilio'
          ? {
              provider: 'twilio',
              accountSid: connectForm.accountSid,
              authToken: connectForm.authToken,
            }
          : {
              provider: 'vobiz',
              authId: connectForm.vobizAuthId,
              authToken: connectForm.vobizAuthToken,
              ...(connectForm.vobizCustomerAuthId ? { customerAuthId: connectForm.vobizCustomerAuthId } : {}),
            };
      const connection = await call<TelephonyConnection>(`/workspaces/${workspaceId}/telephony/connections`, {
        method: 'POST',
        body: JSON.stringify({
          provider: connectForm.provider,
          display_name: connectForm.displayName || providerLabel(connectForm.provider),
          credentials,
        }),
      });
      setActiveConnectionId(connection.id);
      await syncNumbers(connection.id);
      await refresh();
    } catch (err) {
      handleApiError(err, 'Connection failed');
    } finally {
      setBusy(null);
    }
  }

  async function syncNumbers(connectionId: string) {
    if (!workspaceId) return;
    setBusy(`sync-${connectionId}`);
    setError(null);
    try {
      const res = await call<{ items: ProviderNumber[] }>(
        `/workspaces/${workspaceId}/telephony/connections/${connectionId}/sync-numbers`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setProviderNumbers(res.items ?? []);
      setSelectedProviderNumbers(new Set((res.items ?? []).map((number) => number.provider_number_id)));
      setPhoneNumberOverrides({});
      setSipDomainOverrides({});
      setImportWebhookSecret('');
      setActiveConnectionId(connectionId);
    } catch (err) {
      handleApiError(err, 'Number sync failed');
    } finally {
      setBusy(null);
    }
  }

  async function importSelectedNumbers() {
    if (!workspaceId || !activeConnectionId) return;
    const selected = providerNumbers.filter((number) => selectedProviderNumbers.has(number.provider_number_id));
    if (!selected.length) return;
    const invalid = selected.filter((number) => !E164_PHONE_PATTERN.test(importPhoneNumber(number)));
    if (invalid.length) {
      setError('Enter a valid E.164 phone number for each selected trunk before importing.');
      return;
    }
    const missingVobizDomains = selected.filter(
      (number) =>
        activeConnection?.provider === 'vobiz' &&
        number.metadata?.requiresPhoneNumber === true &&
        !importSipDomain(number),
    );
    if (missingVobizDomains.length) {
      setError('Enter the unique Vobiz SIP prefix or full outbound SIP domain for each selected trunk.');
      return;
    }
    if (activeConnection?.provider === 'vobiz' && !importWebhookSecret.trim()) {
      setError('Enter the Vobiz webhook signing secret before importing selected numbers.');
      return;
    }
    const importNumbers = selected.map((number) => ({
      provider_number_id: number.provider_number_id,
      phone_number: importPhoneNumber(number),
      friendly_name: number.friendly_name ?? undefined,
      capabilities: number.capabilities,
      webhook_secret: activeConnection?.provider === 'vobiz' ? importWebhookSecret.trim() : undefined,
      metadata: {
        ...(number.metadata ?? {}),
        ...(number.phone_number ? {} : { phoneNumberSource: 'manual_import' }),
        ...(importSipDomain(number) ? { sipTrunkDomain: importSipDomain(number) } : {}),
      },
    }));
    setBusy('import');
    setError(null);
    try {
      await call(`/workspaces/${workspaceId}/telephony/phone-numbers/import`, {
        method: 'POST',
        body: JSON.stringify({
          connection_id: activeConnectionId,
          numbers: importNumbers,
        }),
      });
      setProviderNumbers([]);
      setSelectedProviderNumbers(new Set());
      setPhoneNumberOverrides({});
      setSipDomainOverrides({});
      setImportWebhookSecret('');
      setPanel(null);
      await refresh();
    } catch (err) {
      handleApiError(err, 'Import failed');
    } finally {
      setBusy(null);
    }
  }

  function importPhoneNumber(number: ProviderNumber): string {
    return (number.phone_number ?? phoneNumberOverrides[number.provider_number_id] ?? '').trim();
  }

  function importSipDomain(number: ProviderNumber): string {
    const fromProvider = typeof number.metadata?.sipTrunkDomain === 'string'
      ? number.metadata.sipTrunkDomain
      : '';
    return (fromProvider || sipDomainOverrides[number.provider_number_id] || '').trim();
  }

  async function createSipNumber(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId) return;
    setBusy('sip');
    setError(null);
    try {
      await call(`/workspaces/${workspaceId}/telephony/phone-numbers/sip`, {
        method: 'POST',
        body: JSON.stringify({
          phone_number: sipForm.phoneNumber,
          sip_trunk_domain: sipForm.sipTrunkDomain,
          sip_auth_username: sipForm.sipAuthUsername || undefined,
          sip_auth_password: sipForm.sipAuthPassword || undefined,
        }),
      });
      setSipForm(emptySipForm);
      setPanel(null);
      await refresh();
    } catch (err) {
      handleApiError(err, 'SIP trunk setup failed');
    } finally {
      setBusy(null);
    }
  }

  async function updateNumberSettings(
    number: PhoneNumber,
    patch: { agentId?: string | null; inboundEnabled?: boolean; outboundEnabled?: boolean },
  ) {
    if (!workspaceId) return;
    setBusy(`assign-${number.id}`);
    setError(null);
    try {
      await call(`/workspaces/${workspaceId}/telephony/phone-numbers/${number.id}/assign-agent`, {
        method: 'POST',
        body: JSON.stringify({
          agent_id: patch.agentId !== undefined ? patch.agentId : number.assigned_agent_id ?? null,
          inbound_enabled: patch.inboundEnabled ?? number.inbound_enabled,
          outbound_enabled: patch.outboundEnabled ?? number.outbound_enabled,
        }),
      });
      await refresh();
    } catch (err) {
      handleApiError(err, 'Phone number update failed');
    } finally {
      setBusy(null);
    }
  }

  async function configureLiveKit(numberId: string) {
    if (!workspaceId) return;
    setBusy(`livekit-${numberId}`);
    setError(null);
    try {
      const result = await call<{
        data?: { provider_routing?: { status?: string; message?: string; manualInstructions?: string } };
      }>(`/workspaces/${workspaceId}/telephony/phone-numbers/${numberId}/configure-livekit`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const routing = result?.data?.provider_routing;
      setManualSteps((prev) => {
        const next = { ...prev };
        if (routing?.status === 'manual_required') {
          next[numberId] = [routing.message, routing.manualInstructions]
            .filter(Boolean)
            .join(SECTION_BREAK);
        } else {
          delete next[numberId];
        }
        return next;
      });
      await refresh();
    } catch (err) {
      handleApiError(err, 'LiveKit configuration failed');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(numberId: string) {
    if (!workspaceId || !confirm('Disconnect this phone number from VoiceForge?')) return;
    setBusy(`delete-${numberId}`);
    setError(null);
    try {
      await call(`/workspaces/${workspaceId}/telephony/phone-numbers/${numberId}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      handleApiError(err, 'Disconnect failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    /*
     * ph-no-capture: provider auth tokens, SIP credentials, webhook secrets and
     * the phone-number inventory itself are all rendered on this page.
     */
    <div className="ph-no-capture flex flex-col gap-8">
      <UpgradeModal
        open={Boolean(planLimit)}
        onClose={() => setPlanLimit(null)}
        limitType={planLimit?.limitType}
        currentPlan={planLimit?.currentPlan}
        onUpgrade={() => {
          const path = planLimit?.upgradePath ?? '/dashboard/billing';
          setPlanLimit(null);
          router.push(path);
        }}
      />
      <PageHeader
        eyebrow="Telephony"
        title="Phone Numbers"
        description="Import numbers from your own Twilio or Vobiz account, or bring a number from any SIP trunk. Assign an agent and the call routing configures itself."
        actions={
          <>
            <Button onClick={() => setPanel(panel === 'connect' ? null : 'connect')} className="gap-2">
              <PlugZap className="h-4 w-4" />
              Import from your provider
            </Button>
            <Button variant="outline" onClick={() => setPanel(panel === 'sip' ? null : 'sip')} className="gap-2">
              <Phone className="h-4 w-4" />
              Add a SIP trunk number
            </Button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-4">
          <StatCard label="Numbers" value={numbers.length} description="Connected inventory" icon={<Phone className="h-5 w-5" />} />
          <StatCard label="LiveKit" value={stats.livekitReady} description="SIP routes configured" icon={<Router className="h-5 w-5" />} tone="success" />
          <StatCard label="Assigned" value={stats.assigned} description="Linked to agents" icon={<Link className="h-5 w-5" />} tone="info" />
          <StatCard label="Pending" value={stats.pending} description="Need verification" icon={<ShieldCheck className="h-5 w-5" />} />
        </div>
      </PageHeader>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {panel === 'sip' && (
        <FormSection
          title="Add SIP trunk number"
          description="Bring a number from any SIP trunk provider — VoiceLink (voicelink.co.in), Twilio Elastic SIP, Telnyx, or your own PBX. Enter the trunk details; we configure the LiveKit route and show the SIP host to point your carrier at."
        >
          <form onSubmit={createSipNumber} className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="sip-phone-number">Phone number</Label>
              <Input
                id="sip-phone-number"
                value={sipForm.phoneNumber}
                onChange={(e) => setSipForm((prev) => ({ ...prev, phoneNumber: e.target.value }))}
                placeholder="+15551234567"
                inputMode="tel"
                pattern="^\+[1-9]\d{6,14}$"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sip-trunk-domain">SIP trunk domain</Label>
              <Input
                id="sip-trunk-domain"
                value={sipForm.sipTrunkDomain}
                onChange={(e) => setSipForm((prev) => ({ ...prev, sipTrunkDomain: e.target.value }))}
                placeholder="sip.yourcarrier.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sip-auth-username">SIP trunk username (optional)</Label>
              <Input
                id="sip-auth-username"
                value={sipForm.sipAuthUsername}
                onChange={(e) => setSipForm((prev) => ({ ...prev, sipAuthUsername: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sip-auth-password">SIP trunk password (optional)</Label>
              <Input
                id="sip-auth-password"
                type="password"
                value={sipForm.sipAuthPassword}
                onChange={(e) => setSipForm((prev) => ({ ...prev, sipAuthPassword: e.target.value }))}
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={busy === 'sip'}>
                {busy === 'sip' ? 'Adding...' : 'Add SIP trunk number'}
              </Button>
            </div>
          </form>
        </FormSection>
      )}

      {panel === 'connect' && (
        <FormSection
          title="Import from your provider"
          description="Paste your provider credentials, pick the numbers this workspace should manage, and assign an agent. For Twilio we create the Elastic SIP trunk in your own account, so inbound and outbound both work with no console steps."
        >
          <form onSubmit={createConnection} className="grid gap-4 lg:grid-cols-[180px_1fr_auto] lg:items-end">
            <div className="space-y-2">
              <Label>Provider</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={connectForm.provider}
                onChange={(e) => setConnectForm((prev) => ({ ...prev, provider: e.target.value as Provider }))}
              >
                <option value="twilio">Twilio</option>
                <option value="vobiz">Vobiz / Vobiz.ai</option>
              </select>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Display name</Label>
                <Input
                  value={connectForm.displayName}
                  onChange={(e) => setConnectForm((prev) => ({ ...prev, displayName: e.target.value }))}
                  placeholder={`${providerLabel(connectForm.provider)} production`}
                />
              </div>
              {connectForm.provider === 'twilio' ? (
                <>
                  <div className="space-y-2">
                    <Label>Account SID</Label>
                    <Input value={connectForm.accountSid} onChange={(e) => setConnectForm((prev) => ({ ...prev, accountSid: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Auth token</Label>
                    <Input type="password" value={connectForm.authToken} onChange={(e) => setConnectForm((prev) => ({ ...prev, authToken: e.target.value }))} />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Auth ID</Label>
                    <Input value={connectForm.vobizAuthId} onChange={(e) => setConnectForm((prev) => ({ ...prev, vobizAuthId: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Auth token</Label>
                    <Input type="password" value={connectForm.vobizAuthToken} onChange={(e) => setConnectForm((prev) => ({ ...prev, vobizAuthToken: e.target.value }))} />
                  </div>
                  <div className="space-y-2 md:col-span-3">
                    <Label>Customer auth ID</Label>
                    <Input value={connectForm.vobizCustomerAuthId} onChange={(e) => setConnectForm((prev) => ({ ...prev, vobizCustomerAuthId: e.target.value }))} placeholder="Leave blank unless you have Partner API access" />
                  </div>
                </>
              )}
            </div>
            <Button type="submit" disabled={busy === 'connect'} className="gap-2">
              <KeyRound className="h-4 w-4" />
              {busy === 'connect' ? 'Connecting...' : 'Validate'}
            </Button>
          </form>

          {connections.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {connections.map((connection) => (
                <Button
                  key={connection.id}
                  type="button"
                  variant={activeConnectionId === connection.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => syncNumbers(connection.id)}
                  disabled={busy === `sync-${connection.id}`}
                  className="gap-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {connection.display_name}
                </Button>
              ))}
            </div>
          )}

          {providerNumbers.length > 0 && (
            <div className="mt-5 overflow-hidden rounded-md border border-border">
              {activeConnection?.provider === 'vobiz' ? (
                <div className="border-b border-border bg-muted/20 px-3 py-3">
                  <div className="max-w-xl space-y-2">
                    <Label>Vobiz webhook signing secret</Label>
                    <Input
                      type="password"
                      value={importWebhookSecret}
                      onChange={(e) => setImportWebhookSecret(e.target.value)}
                      placeholder="Required for signed callbacks"
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored encrypted per imported number and required before Vobiz callbacks are accepted.
                    </p>
                  </div>
                </div>
              ) : null}
              <div className="grid grid-cols-[44px_minmax(180px,1fr)_minmax(180px,1fr)_140px_120px] border-b border-border bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span />
                <span>Number</span>
                <span>SIP domain</span>
                <span>Provider ID</span>
                <span>Voice</span>
              </div>
              {providerNumbers.map((number) => (
                <div key={number.provider_number_id} className="grid grid-cols-[44px_minmax(180px,1fr)_minmax(180px,1fr)_140px_120px] items-center gap-2 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Select ${number.friendly_name ?? number.provider_number_id}`}
                    checked={selectedProviderNumbers.has(number.provider_number_id)}
                    onChange={(e) => {
                      setSelectedProviderNumbers((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(number.provider_number_id);
                        else next.delete(number.provider_number_id);
                        return next;
                      });
                    }}
                  />
                  <div className="min-w-0">
                    {number.phone_number ? (
                      <span className="font-mono">{number.phone_number}</span>
                    ) : (
                      <Input
                        className="h-8 font-mono"
                        inputMode="tel"
                        pattern="^\+[1-9]\d{6,14}$"
                        value={phoneNumberOverrides[number.provider_number_id] ?? ''}
                        onChange={(e) => setPhoneNumberOverrides((prev) => ({ ...prev, [number.provider_number_id]: e.target.value }))}
                        placeholder="+912271264217"
                      />
                    )}
                    {number.friendly_name && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{number.friendly_name}</p>
                    )}
                  </div>
                  <div className="min-w-0">
                    {activeConnection?.provider === 'vobiz' && number.metadata?.requiresPhoneNumber === true ? (
                      <div className="flex items-center gap-1">
                        <Input
                          className="h-8 font-mono"
                          value={sipDomainOverrides[number.provider_number_id] ?? ''}
                          onChange={(e) => setSipDomainOverrides((prev) => ({ ...prev, [number.provider_number_id]: e.target.value }))}
                          placeholder="unique-prefix"
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">.sip.vobiz.ai</span>
                      </div>
                    ) : (
                      <span className="truncate text-xs text-muted-foreground">{importSipDomain(number) || 'Not required'}</span>
                    )}
                  </div>
                  <span className="truncate text-xs text-muted-foreground">{number.provider_number_id}</span>
                  <Badge variant="outline">{String(number.capabilities?.voice ?? true)}</Badge>
                </div>
              ))}
              <div className="border-t border-border px-3 py-3">
                <Button onClick={importSelectedNumbers} disabled={busy === 'import'} className="gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  {busy === 'import' ? 'Importing...' : 'Import selected'}
                </Button>
              </div>
            </div>
          )}
        </FormSection>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading phone numbers...</p>
      ) : numbers.length > 0 ? (
        <div className="grid grid-cols-1 gap-3">
          {numbers.map((number) => (
            <Card key={number.id}>
              <CardContent className="grid gap-4 py-4 lg:grid-cols-[1fr_220px_260px] lg:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-card">
                    <Phone className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-mono text-sm font-semibold">{number.phone_number}</p>
                      <StatusBadge status={number.provider} />
                      <StatusBadge status={number.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {number.friendly_name || 'Unnamed number'} · {number.livekit?.sip_host ?? 'LiveKit not configured'}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={number.assigned_agent_id ?? ''}
                    onChange={(e) => updateNumberSettings(number, { agentId: e.target.value || null })}
                    disabled={busy === `assign-${number.id}`}
                  >
                    <option value="">Unassigned</option>
                    {agents.filter((agent) => agent.status === 'published').map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                  {agents.length > 0 && agents.every((agent) => agent.status !== 'published') && (
                    <p className="text-xs text-destructive">
                      No published agents. Publish an agent in the builder before assigning it to a number.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={number.inbound_enabled}
                        onChange={(e) => updateNumberSettings(number, { inboundEnabled: e.target.checked })}
                        disabled={busy === `assign-${number.id}`}
                      />
                      Inbound
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={number.outbound_enabled}
                        onChange={(e) => updateNumberSettings(number, { outboundEnabled: e.target.checked })}
                        disabled={busy === `assign-${number.id}`}
                      />
                      Outbound
                    </label>
                  </div>
                </div>

                <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => configureLiveKit(number.id)}
                    disabled={!number.assigned_agent_id || busy === `livekit-${number.id}`}
                    className="gap-2"
                  >
                    <Router className="h-3.5 w-3.5" />
                    {number.livekit ? 'Reconfigure' : 'Configure'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => disconnect(number.id)} disabled={busy === `delete-${number.id}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                {number.status === 'pending_verification' && (
                  <p className="text-xs text-muted-foreground lg:col-span-3">
                    Import this number from its provider connection to verify it. Until then it cannot
                    take an agent.
                  </p>
                )}

                {manualSteps[number.id] && (
                  <div className="space-y-2 lg:col-span-3">
                    <p className="text-xs font-medium text-amber-700">
                      Your provider needs this done by hand
                    </p>
                    <Textarea readOnly className="font-mono text-xs" rows={4} value={manualSteps[number.id]} />
                  </div>
                )}

                {number.carrier_setup && (
                  <div className="space-y-2 lg:col-span-3">
                    <p className="text-xs font-medium">Give your carrier this</p>
                    <Textarea
                      readOnly
                      className="font-mono text-xs"
                      rows={4}
                      value={[
                        `Send inbound calls to: ${number.carrier_setup.inbound_sip_uri}`,
                        `Digest auth username: ${number.carrier_setup.auth_username ?? 'none (IP allow-list only)'}`,
                        `We dial out through: ${number.carrier_setup.outbound_sip_domain ?? 'not set'}`,
                        number.carrier_setup.ip_allowlist_hint,
                      ].join('\n')}
                    />
                  </div>
                )}

                {number.livekit && (
                  <Textarea
                    readOnly
                    className="font-mono text-xs lg:col-span-3"
                    value={[
                      `SIP host: ${number.livekit.sip_host}`,
                      `Inbound trunk: ${number.livekit.inbound_trunk_id ?? 'not created'}`,
                      `Outbound trunk: ${number.livekit.outbound_trunk_id ?? 'not created'}`,
                      `Dispatch rule: ${number.livekit.dispatch_rule_id ?? 'not created'}`,
                    ].join('\n')}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Phone className="h-7 w-7" />}
          title="No phone numbers connected"
          description="Import numbers from your Twilio or Vobiz account, or bring one from any SIP trunk."
        />
      )}
    </div>
  );
}

function providerLabel(provider: Provider): string {
  return { twilio: 'Twilio', vobiz: 'Vobiz', sip: 'SIP trunk' }[provider];
}
