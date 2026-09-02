'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, FormSection, PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import { useApi } from '@/lib/use-api';
import { AlertCircle, Megaphone, Pause, Phone, Play, Plus, Upload, Users } from 'lucide-react';
import { normalizePhone } from '@voiceforge/shared';

interface Campaign {
  id: string;
  name: string;
  status: string;
  stats: { total: number; completed: number; failed: number; in_progress: number };
  agent: { id: string; name: string } | null;
  createdAt: string;
}

interface CampaignContact {
  phone: string;
  full_name?: string;
  email?: string;
  custom_data?: Record<string, string>;
}

interface ContactValidationError {
  row: number;
  phone?: string;
  email?: string;
  message: string;
}

interface SessionUser {
  active_workspace_id: string;
}

interface AgentSummary {
  id: string;
  name: string;
  status: string;
}

interface TelephonyNumberSummary {
  id: string;
  status: string;
  outbound_enabled: boolean;
}

const CONTACTS_PLACEHOLDER = [
  '+14155551111, John Doe',
  '+14155552222, Jane Smith, jane@example.com',
].join('\n');

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).filter((l) => l.trim()).map((l) =>
    l.split(',').map((c) => c.trim())
  );
  return { headers, rows };
}

export default function CampaignsPage() {
  const { call } = useApi();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [hasNumber, setHasNumber] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<'list' | 'upload' | 'preview' | 'schedule' | 'compliance'>('list');
  const [formName, setFormName] = useState('');
  const [formAgent, setFormAgent] = useState('');
  const [formPurpose, setFormPurpose] = useState('');
  const [contacts, setContacts] = useState<CampaignContact[]>([]);
  const [errors, setErrors] = useState<ContactValidationError[]>([]);
  const [schedule, setSchedule] = useState({ max_calls_per_hour: 10, max_concurrent: 3 });
  const [consentChecked, setConsentChecked] = useState(false);
  const [dncChecked, setDncChecked] = useState(false);
  const [consentType, setConsentType] = useState<'outbound_transactional' | 'outbound_marketing'>(
    'outbound_transactional',
  );
  const [consentSource, setConsentSource] = useState('');
  const [windowEnabled, setWindowEnabled] = useState(false);
  const [callWindow, setCallWindow] = useState({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    start_hour: 9,
    end_hour: 20,
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err: unknown) => {
        setLoading(false);
        setLoadError(err instanceof Error ? err.message : 'Could not load your workspace.');
      });
  }, [call]);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`),
      call<{ items: AgentSummary[] }>(`/workspaces/${workspaceId}/agents`),
      call<{ items: TelephonyNumberSummary[] }>(`/workspaces/${workspaceId}/telephony/phone-numbers`),
      call<{ items: { id: string }[] }>(`/workspaces/${workspaceId}/phone-numbers`),
    ])
      .then(([c, a, telephony, legacy]) => {
        setCampaigns(c.items ?? []);
        setAgents(a.items ?? []);
        setHasNumber(
          (legacy.items ?? []).length > 0 ||
            (telephony.items ?? []).some(
              (n) => n.outbound_enabled && !['pending_verification', 'disconnected'].includes(n.status),
            ),
        );
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : 'Campaigns could not be loaded.'),
      )
      .finally(() => setLoading(false));
  }, [workspaceId, call]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const { headers, rows } = parseCSV(text);
      const phoneIdx = headers.indexOf('phone');
      const nameIdx = headers.indexOf('name');
      const emailIdx = headers.indexOf('email');

      const validated: CampaignContact[] = [];
      const errs: ContactValidationError[] = [];

      rows.forEach((row, i) => {
        const rawPhone = row[phoneIdx] ?? '';
        const phone = normalizePhone(rawPhone);
        const email = emailIdx >= 0 ? row[emailIdx] : undefined;
        if (!phone) {
          errs.push({ row: i + 2, phone: rawPhone, message: `Invalid phone: "${rawPhone}"` });
          return;
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          errs.push({ row: i + 2, email, message: `Invalid email: "${email}"` });
        }
        validated.push({
          phone,
          full_name: nameIdx >= 0 ? row[nameIdx] : undefined,
          email: email ?? undefined,
        });
      });

      setContacts(validated);
      setErrors(errs);
      setStep('preview');
    };
    reader.readAsText(file);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !formName || !formAgent || !formPurpose) return;
    setCreating(true);
    try {
      const campaign = await call<Campaign>(`/workspaces/${workspaceId}/campaigns`, {
        method: 'POST',
        body: JSON.stringify({
          name: formName,
          agent_id: formAgent,
          purpose: formPurpose,
          contacts,
          schedule,
          // One attestation for the whole list; the API writes the consent
          // record for every contact. The window applies to every dial.
          compliance: {
            consent: { consent_type: consentType, source_description: consentSource.trim() },
            ...(windowEnabled ? { call_window: callWindow } : {}),
          },
        }),
      });
      await call(`/workspaces/${workspaceId}/campaigns/${campaign.id}/start`, {
        method: 'POST',
      });
      resetForm();
      const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
      setCampaigns(res.items ?? []);
      setStep('list');
    } catch (err) {
      handleCampaignError(err);
    } finally {
      setCreating(false);
    }
  }

  // The API rejects campaign create/start with PHONE_NUMBER_REQUIRED (409) when
  // the workspace has no outbound-capable number — route the user to fix it.
  function handleCampaignError(err: unknown) {
    if ((err as { code?: string })?.code === 'PHONE_NUMBER_REQUIRED') {
      toast.error(err instanceof Error ? err.message : 'Add a phone number first');
      router.push('/dashboard/settings/phone-numbers');
      return;
    }
    // A compliance refusal names its reasons; an opaque 422 sent people
    // guessing between consent, DNC, purpose and calling hours.
    if ((err as { code?: string })?.code === 'COMPLIANCE_BLOCKED') {
      const reasons = (err as { details?: { reasons?: Array<{ message?: string }> } }).details
        ?.reasons
        ?.map((r) => r.message)
        .filter(Boolean);
      toast.error(reasons?.length ? reasons.join(' ') : 'Compliance blocked this campaign.');
      return;
    }
    toast.error(err instanceof Error ? err.message : 'The campaign action failed.');
  }

  function resetForm() {
    setFormName('');
    setFormAgent('');
    setContacts([]);
    setErrors([]);
    setSchedule({ max_calls_per_hour: 10, max_concurrent: 3 });
    setConsentChecked(false);
    setDncChecked(false);
    setConsentSource('');
    setWindowEnabled(false);
    if (fileRef.current) fileRef.current.value = '';
  }


  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading...</p>;

  // ---- List view ----
  if (step === 'list') {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Outbound automation"
          title="Outbound campaigns"
          description="Schedule and run bulk outbound calling campaigns with voice agents, guardrails, and per-campaign rate limits."
          actions={
            hasNumber ? (
              <Button onClick={() => setStep('upload')} className="gap-2">
                <Plus className="h-4 w-4" />
                New campaign
              </Button>
            ) : undefined
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Campaigns"
              value={campaigns.length}
              description="Total configured campaigns"
              icon={<Megaphone className="h-5 w-5" />}
            />
            <StatCard
              label="Running"
              value={campaigns.filter((c) => c.status === 'running').length}
              description="Actively dialing contacts"
              tone="success"
              icon={<Play className="h-5 w-5" />}
            />
            <StatCard
              label="Contacts"
              value={campaigns.reduce((sum, c) => sum + c.stats.total, 0)}
              description="Queued across all campaigns"
              tone="info"
              icon={<Users className="h-5 w-5" />}
            />
            <StatCard
              label="Completed"
              value={campaigns.reduce((sum, c) => sum + c.stats.completed, 0)}
              description="Completed campaign calls"
              tone="success"
            />
          </div>
        </PageHeader>

        {loadError ? (
          // Not the empty state: an empty list here would read as "no campaigns"
          // and the number gate below would read as "no number".
          <EmptyState
            icon={<AlertCircle className="h-7 w-7" />}
            title="Campaigns could not be loaded"
            description={loadError}
          />
        ) : !hasNumber ? (
          <EmptyState
            icon={<Phone className="h-7 w-7" />}
            title="Add a phone number first"
            description="Campaigns place real outbound calls, so this workspace needs an outbound-enabled phone number before you can create or run one."
            actionLabel="Go to phone numbers"
            actionHref="/dashboard/settings/phone-numbers"
          />
        ) : campaigns.length > 0 ? (
          <div className="grid gap-4">
            {campaigns.map((c) => (
              <Card key={c.id} className="overflow-hidden bg-card/95 shadow-sm">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                        <Megaphone className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.agent ? `Agent: ${c.agent.name}` : 'No agent'} ·{' '}
                          Created {new Date(c.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={c.status} />
                      {c.status === 'draft' || c.status === 'paused' ? (
                        <Button size="sm" onClick={async () => {
                          try {
                            await call(`/workspaces/${workspaceId}/campaigns/${c.id}/start`, { method: 'POST' });
                            const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
                            setCampaigns(res.items ?? []);
                          } catch (err) {
                            handleCampaignError(err);
                          }
                        }}>
                          <Play className="h-3 w-3" /> Start
                        </Button>
                      ) : c.status === 'running' ? (
                        <Button size="sm" variant="outline" onClick={async () => {
                          try {
                            await call(`/workspaces/${workspaceId}/campaigns/${c.id}/pause`, { method: 'PATCH' });
                            const res = await call<{ items: Campaign[] }>(`/workspaces/${workspaceId}/campaigns`);
                            setCampaigns(res.items ?? []);
                          } catch (err) {
                            handleCampaignError(err);
                          }
                        }}>
                          <Pause className="h-3 w-3" /> Pause
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-4 text-center">
                    {[
                      { label: 'Total', value: c.stats.total },
                      { label: 'Completed', value: c.stats.completed },
                      { label: 'Failed', value: c.stats.failed },
                      { label: 'In Progress', value: c.stats.in_progress },
                    ].map((s) => (
                      <div key={s.label} className="rounded-md bg-muted/50 p-2">
                        <p className="text-lg font-semibold">{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Megaphone className="h-7 w-7" />}
            title="No campaigns yet"
            description="Create a campaign to upload contacts, review compliance, set rate limits, and start outbound calling."
          />
        )}
      </div>
    );
  }

  // ---- Step 1: Upload ----
  if (step === 'upload') {
    return (
      /* ph-no-capture: raw contact list — phone numbers, names and emails are
         typed or pasted directly into this step. */
      <div className="ph-no-capture flex flex-col gap-8">
        <PageHeader
          eyebrow="Step 1"
          title="Upload contacts"
          description="Import a CSV or paste one contact per line. Phone numbers are normalized before preview."
          actions={
            <Button variant="outline" onClick={() => { resetForm(); setStep('list'); }}>
              Back to campaigns
            </Button>
          }
        />

        <FormSection
          icon={<Upload className="h-4 w-4" />}
          title="Upload CSV"
          description="CSV files should include a phone column, with optional name and email columns."
        >
            <div className="flex flex-col items-center justify-center gap-4">
              <Upload className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Upload a CSV with columns: <code className="text-xs bg-muted px-1 rounded">phone</code>,{' '}
                <code className="text-xs bg-muted px-1 rounded">name</code>,{' '}
                <code className="text-xs bg-muted px-1 rounded">email</code> (optional)
              </p>
              <label htmlFor="campaign-csv" className="sr-only">
                Contacts CSV file
              </label>
              <input
                id="campaign-csv"
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="text-sm"
                onChange={handleFileChange}
              />
            </div>
        </FormSection>

        <FormSection title="Or paste contacts">
            <p className="mb-3 text-xs text-muted-foreground">
              One contact per line: <code className="bg-muted px-1 rounded">phone[, name[, email]]</code>
            </p>
            <label htmlFor="campaign-contacts" className="sr-only">
              Contacts, one per line
            </label>
            <textarea
              id="campaign-contacts"
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
              rows={6}
              placeholder={CONTACTS_PLACEHOLDER}
              onChange={(e) => {
                const lines = e.target.value.trim().split('\n').filter(Boolean);
                const parsed: CampaignContact[] = [];
                const errs: ContactValidationError[] = [];
                lines.forEach((line, i) => {
                  const parts = line.split(',');
                  const rawPhone = parts[0].trim();
                  const phone = normalizePhone(rawPhone);
                  if (!phone) {
                    errs.push({ row: i + 1, phone: rawPhone, message: `Invalid phone: "${rawPhone}"` });
                    return;
                  }
                  parsed.push({
                    phone,
                    full_name: parts[1]?.trim() || undefined,
                    email: parts[2]?.trim() || undefined,
                  });
                });
                setContacts(parsed);
                setErrors(errs);
              }}
            />
            <Button
              className="mt-3"
              onClick={() => {
                if (contacts.length > 0) setStep('preview');
              }}
            >
              Continue →
            </Button>
        </FormSection>
      </div>
    );
  }

  // ---- Step 2: Preview ----
  if (step === 'preview') {
    return (
      /* ph-no-capture: renders the normalized contact table and validation
         errors, both of which echo the dialled numbers back to the screen. */
      <div className="ph-no-capture flex flex-col gap-8">
        <PageHeader
          eyebrow="Step 2"
          title="Preview and validate"
          description="Review normalized contacts and resolve validation errors before scheduling."
          actions={<Button variant="outline" onClick={() => setStep('upload')}>Back to upload</Button>}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard label="Valid contacts" value={contacts.length} description="Ready to add to the campaign" />
            <StatCard
              label="Validation errors"
              value={errors.length}
              description={errors.length > 0 ? 'Fix before continuing' : 'No blocking errors'}
              tone={errors.length > 0 ? 'danger' : 'success'}
            />
          </div>
        </PageHeader>

        {errors.length > 0 && (
          <Card className="border-destructive/50">
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-destructive mb-2">
                <AlertCircle className="h-4 w-4" />
                <span className="text-sm font-medium">{errors.length} validation error(s)</span>
              </div>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {errors.map((err, i) => (
                  <div key={i} className="flex gap-2 text-xs text-muted-foreground">
                    <span className="text-muted-foreground">Row {err.row}:</span>
                    <span>{err.message}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center gap-4">
          <p className="text-sm">
            <span className="font-semibold">{contacts.length}</span> contacts valid
            {errors.length > 0 && <span className="text-destructive"> — fix errors before continuing</span>}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setStep('upload')}
          >
            Re-upload
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Phone</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                </tr>
              </thead>
              <tbody>
                {contacts.slice(0, 20).map((c, i) => (
                  <tr key={i} className="border-b">
                    <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-2 font-mono">{c.phone}</td>
                    <td className="px-3 py-2">{c.full_name ?? '—'}</td>
                    <td className="px-3 py-2">{c.email ?? '—'}</td>
                  </tr>
                ))}
                {contacts.length > 20 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-center text-xs text-muted-foreground">
                      +{contacts.length - 20} more contacts...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Button onClick={() => setStep('schedule')} disabled={errors.length > 0}>
          Next: Schedule →
        </Button>
      </div>
    );
  }

  // ---- Step 3: Schedule ----
  if (step === 'schedule') {
    return (
      /* ph-no-capture: campaign name and agent selection are customer-authored. */
      <div className="ph-no-capture flex flex-col gap-8">
        <PageHeader
          eyebrow="Step 3"
          title="Schedule and launch"
          description="Choose the agent, set throughput limits, and confirm consent before starting outbound dialing."
          actions={<Button variant="outline" onClick={() => setStep('preview')}>Back to preview</Button>}
        />

        <form onSubmit={handleCreate} className="flex flex-col gap-6">
          <FormSection title="Campaign details">
            <div className="flex flex-col gap-4">
              <div>
                <Label htmlFor="campaign-name">Campaign Name</Label>
                <Input
                  id="campaign-name"
                  className="mt-1"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Q2 Patient Recall"
                  required
                />
              </div>
              <div>
                <Label htmlFor="campaign-agent">Voice Agent</Label>
                <select
                  id="campaign-agent"
                  className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={formAgent}
                  onChange={(e) => setFormAgent(e.target.value)}
                  required
                >
                  <option value="">Select agent...</option>
                  {agents.filter((a) => a.status === 'published').map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {agents.length > 0 && agents.every((a) => a.status !== 'published') && (
                  <p className="mt-1 text-xs text-destructive">
                    No published agents. Publish an agent in the builder before creating a campaign.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="campaign-purpose">Call purpose</Label>
                <select
                  id="campaign-purpose"
                  className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={formPurpose}
                  onChange={(e) => setFormPurpose(e.target.value)}
                  required
                >
                  <option value="">Select purpose...</option>
                  <option value="appointment_reminder">Appointment reminder</option>
                  <option value="missed_call_callback">Missed-call callback</option>
                  <option value="lead_form_callback">Lead form callback</option>
                  <option value="order_confirmation">Order confirmation</option>
                  <option value="event_confirmation">Event confirmation</option>
                  <option value="requested_follow_up">Requested follow-up</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Campaigns can only dial contacts who consented to this purpose; cold outreach is not supported.
                </p>
              </div>
            </div>
          </FormSection>

          <FormSection title="Rate limits">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="campaign-max-calls">Max calls per hour</Label>
                <Input
                  id="campaign-max-calls"
                  className="mt-1"
                  type="number"
                  min={1}
                  max={100}
                  value={schedule.max_calls_per_hour}
                  onChange={(e) => setSchedule((s) => ({ ...s, max_calls_per_hour: parseInt(e.target.value) || 1 }))}
                />
              </div>
              <div>
                <Label htmlFor="campaign-max-concurrent">Max concurrent calls</Label>
                <Input
                  id="campaign-max-concurrent"
                  className="mt-1"
                  type="number"
                  min={1}
                  max={10}
                  value={schedule.max_concurrent}
                  onChange={(e) => setSchedule((s) => ({ ...s, max_concurrent: parseInt(e.target.value) || 1 }))}
                />
              </div>
            </div>
          </FormSection>

          <FormSection title="Compliance">
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Set once for all {contacts.length} contacts. Your attestation records consent for every
                number in this list; numbers on your Do-Not-Call list or who opted out are still skipped
                one by one.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="campaign-consent-type">Consent type</Label>
                  <select
                    id="campaign-consent-type"
                    className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={consentType}
                    onChange={(e) =>
                      setConsentType(e.target.value as 'outbound_transactional' | 'outbound_marketing')
                    }
                  >
                    <option value="outbound_transactional">Transactional (orders, appointments, follow-ups)</option>
                    <option value="outbound_marketing">Marketing (offers, promotions)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="campaign-consent-source">How consent was obtained</Label>
                  <Input
                    id="campaign-consent-source"
                    className="mt-1"
                    value={consentSource}
                    onChange={(e) => setConsentSource(e.target.value)}
                    placeholder="Signed order forms, Aug 2026"
                    maxLength={200}
                    required
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={windowEnabled}
                  onChange={(e) => setWindowEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                Only call between certain hours
              </label>
              {windowEnabled && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="campaign-window-tz">Timezone</Label>
                    <Input
                      id="campaign-window-tz"
                      className="mt-1"
                      value={callWindow.timezone}
                      onChange={(e) => setCallWindow((w) => ({ ...w, timezone: e.target.value }))}
                      placeholder="Asia/Kolkata"
                    />
                  </div>
                  <div>
                    <Label htmlFor="campaign-window-start">From (hour)</Label>
                    <Input
                      id="campaign-window-start"
                      className="mt-1"
                      type="number"
                      min={0}
                      max={23}
                      value={callWindow.start_hour}
                      onChange={(e) =>
                        setCallWindow((w) => ({ ...w, start_hour: Math.min(23, Math.max(0, parseInt(e.target.value) || 0)) }))
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="campaign-window-end">Until (hour)</Label>
                    <Input
                      id="campaign-window-end"
                      className="mt-1"
                      type="number"
                      min={0}
                      max={23}
                      value={callWindow.end_hour}
                      onChange={(e) =>
                        setCallWindow((w) => ({ ...w, end_hour: Math.min(23, Math.max(0, parseInt(e.target.value) || 0)) }))
                      }
                    />
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={consentChecked}
                  onChange={(e) => setConsentChecked(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                  required
                />
                I attest that every contact in this list gave the consent selected above.
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={dncChecked}
                  onChange={(e) => setDncChecked(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                  required
                />
                I have verified contacts are not on the Do-Not-Call registry.
              </label>
              <p className="text-xs text-muted-foreground">
                {contacts.length} contacts will be added to this campaign. The compliance check will run per-call before dialing.
              </p>
            </div>
          </FormSection>

          <div className="flex gap-3">
            <Button
              type="submit"
              disabled={
                creating ||
                !formName ||
                !formAgent ||
                !consentChecked ||
                !dncChecked ||
                consentSource.trim().length < 3
              }
            >
              {creating ? 'Creating & Starting...' : `Launch Campaign (${contacts.length} contacts)`}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetForm(); setStep('list'); }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return null;
}
