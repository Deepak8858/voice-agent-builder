'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AgentDetail,
  AgentSummary,
  SessionUser,
  KnowledgeSourceSummary,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore } from '@/lib/stores/agent-draft';
import { AgentBuilderForm } from '@/components/agent-builder-form';
import { AgentPreviewPanel } from '@/components/agent-preview-panel';
import { RotateCcw, Save, PhoneIncoming, PhoneOutgoing, Phone } from 'lucide-react';

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  industry: string;
  agent_type: string;
}

function CallDirectionSelector({
  value,
  onChange,
}: {
  value: 'inbound' | 'outbound' | 'both';
  onChange: (v: 'inbound' | 'outbound' | 'both') => void;
}) {
  const options = [
    { value: 'inbound' as const, label: 'Inbound only', icon: PhoneIncoming },
    { value: 'outbound' as const, label: 'Outbound only', icon: PhoneOutgoing },
    { value: 'both' as const, label: 'Both directions', icon: Phone },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {options.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
            value === v
              ? 'border-primary bg-primary/5 text-primary'
              : 'border-border hover:bg-muted/50'
          }`}
        >
          <Icon className="h-5 w-5" />
          {label}
        </button>
      ))}
    </div>
  );
}

export default function AiGenerateAgentPage() {
  const router = useRouter();
  const { call } = useApi();
  const draft = useAgentDraftStore();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => toast.error(`Session: ${err.message}`));
  }, [call]);

  const knowledgeQuery = useQuery({
    queryKey: ['knowledge-sources', 'workspace', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      call<{ items: KnowledgeSourceSummary[] }>(
        `/workspaces/${workspaceId}/knowledge-sources?scope=workspace`,
      ),
  });

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => call<{ items: TemplateSummary[] }>('/templates'),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No active workspace');
      return call<{ agent_id: string; status_url: string }>(
        '/agents/generate',
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: draft.prompt,
            template_slug: draft.templateSlug ?? undefined,
            crm_providers: draft.crmProviders.length > 0 ? draft.crmProviders : undefined,
            call_direction: draft.callDirection,
            voice_config: draft.voiceConfig ?? undefined,
          }),
        },
      );
    },
    onSuccess: (res) => {
      draft.setGenerated(res);
      draft.setIsPolling(true);
      toast.success('Generation started. Watch progress in the preview panel.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !draft.draftSpec) throw new Error('Generate an agent first');
      return call<AgentDetail>(
        `/workspaces/${workspaceId}/agents`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: (draft.draftSpec as { name?: string }).name ?? 'Untitled Agent',
            description: (draft.draftSpec as { description?: string }).description ?? undefined,
            industry: (draft.draftSpec as { industry?: string }).industry ?? 'General',
            agent_type: (draft.draftSpec as { agent_type?: string }).agent_type ?? 'inbound_receptionist',
            spec: draft.draftSpec,
          }),
        },
      );
    },
    onSuccess: (agent) => {
      toast.success('Agent created.');
      draft.reset();
      router.push(`/dashboard/agents/${(agent as AgentSummary).id}/builder`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">AI Agent Generator</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Describe in plain English. VoiceForge handles spec, CRM routing, docs, and phone setup.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => draft.reset()} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
          {draft.draftSpec && (
            <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !workspaceId} className="gap-2">
              <Save className="h-4 w-4" />
              {createMutation.isPending ? 'Saving…' : 'Save Agent'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr]">
        {/* Left: Form */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                Describe your agent
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="prompt">What should this agent do?</Label>
                <Textarea
                  id="prompt"
                  rows={5}
                  value={draft.prompt}
                  onChange={(e) => draft.setPrompt(e.target.value)}
                  placeholder="Create an AI receptionist for a dental clinic that books appointments, qualifies leads, and routes to HubSpot."
                  className="mt-1.5"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Industry Template</Label>
                  <select
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={draft.templateSlug ?? ''}
                    onChange={(e) => draft.setTemplate(e.target.value || null)}
                    disabled={templatesQuery.isPending}
                  >
                    <option value="">Auto-match from prompt</option>
                    {templatesQuery.data?.items.map((t) => (
                      <option key={t.slug} value={t.slug}>{t.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Business Name</Label>
                  <Input className="mt-1.5" value={draft.businessName} onChange={(e) => draft.setBusinessName(e.target.value)} placeholder="Smile Dental Clinic" />
                </div>
                <div className="col-span-2">
                  <Label>Timezone</Label>
                  <Input className="mt-1.5" value={draft.timezone} onChange={(e) => draft.setTimezone(e.target.value)} placeholder="America/Los_Angeles" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-primary" />
                Call Direction
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CallDirectionSelector value={draft.callDirection} onChange={draft.setCallDirection} />
              <p className="text-xs text-muted-foreground mt-1">
                {draft.callDirection === 'inbound' && 'Agent receives calls from customers via your phone number.'}
                {draft.callDirection === 'outbound' && 'Agent initiates outbound calls, e.g., reminders or campaigns.'}
                {draft.callDirection === 'both' && 'Agent handles both inbound reception and outbound campaigns.'}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                CRM Connections
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {['pipedrive', 'hubspot', 'salesforce', 'generic_webhook'].map((p) => (
                  <button
                    key={p}
                    onClick={() => {
                      if (draft.crmProviders.includes(p)) {
                        draft.setCrmProviders(draft.crmProviders.filter(c => c !== p));
                      } else {
                        draft.setCrmProviders([...draft.crmProviders, p]);
                      }
                    }}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      draft.crmProviders.includes(p)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:bg-muted/50 text-muted-foreground'
                    }`}
                  >
                    {p.replace('_', ' ')}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Keywords in your prompt auto-route calls to the right CRM. Add credentials via Settings &rarr; CRM Connections.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <svg className="h-4 w-4 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                Voice Settings (optional)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="stt">STT Model</Label>
                  <select
                    id="stt"
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={draft.voiceConfig?.stt_model ?? 'nova-3'}
                    onChange={(e) => draft.setVoiceConfig({ ...(draft.voiceConfig ?? {}), stt_model: e.target.value })}
                  >
                    <option value="nova-3">Nova-3 (default, fast)</option>
                    <option value="nova-2">Nova-2 (accurate)</option>
                    <option value="base">Base (budget)</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="tts">TTS Voice</Label>
                  <select
                    id="tts"
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={draft.voiceConfig?.tts_voice ?? 'aura-2-en-us'}
                    onChange={(e) => draft.setVoiceConfig({ ...(draft.voiceConfig ?? {}), tts_voice: e.target.value })}
                  >
                    <option value="aura-2-en-us">Aura-2 US English (default)</option>
                    <option value="aura-2-en-au">Aura-2 Australian English</option>
                    <option value="aura-2-en-gb">Aura-2 British English</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <div>
            <Label>Workspace knowledge (optional)</Label>
            {knowledgeQuery.data && knowledgeQuery.data.items.length > 0 ? (
              <ul className="mt-1.5 space-y-1 rounded-md border border-border bg-background p-3">
                {knowledgeQuery.data.items.map((k) => (
                  <li key={k.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.knowledgeSourceIds.includes(k.id)}
                      onChange={() => draft.toggleKnowledgeSourceId(k.id)}
                      className="rounded border-border"
                    />
                    <span className="truncate text-foreground">
                      {k.title}{' '}
                      <span className="text-xs text-muted-foreground">
                        ({k.source_type} · {k.chunk_count} chunks)
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">
                No workspace-level knowledge sources yet. Add them via the Knowledge admin screen.
              </p>
            )}
          </div>

          <Button
            onClick={() => generateMutation.mutate()}
            disabled={draft.prompt.length < 10 || generateMutation.isPending}
            className="gap-2 self-start"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            {generateMutation.isPending ? 'Starting generation…' : 'Generate Agent'}
          </Button>
        </div>

        {/* Right: Preview */}
        <AgentPreviewPanel />
      </div>
    </div>
  );
}