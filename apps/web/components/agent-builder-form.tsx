'use client';

import { useEffect } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore } from '@/lib/stores/agent-draft';
import { Bot, PhoneIncoming, PhoneOutgoing, Phone, Sparkles } from 'lucide-react';

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  industry: string;
  agent_type: string;
}

export function AgentBuilderForm() {
  const { call } = useApi();
  const {
    prompt, setPrompt,
    templateSlug, setTemplate,
    businessName, setBusinessName,
    timezone, setTimezone,
    knowledgeSourceIds,
    crmProviders, setCrmProviders,
    callDirection, setCallDirection,
    voiceConfig, setVoiceConfig,
    generated, setGenerated,
    draftSpec,
  } = useAgentDraftStore();

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => call<{ items: TemplateSummary[] }>('/templates'),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      return call<{ agent_id: string; status_url: string }>(
        '/agents/generate',
        {
          method: 'POST',
          body: JSON.stringify({
            prompt,
            template_slug: templateSlug ?? undefined,
            crm_providers: crmProviders.length > 0 ? crmProviders : undefined,
            call_direction: callDirection,
            voice_config: voiceConfig ?? undefined,
          }),
        },
      );
    },
    onSuccess: (res) => {
      setGenerated(res);
      toast.success('Generation started. Watch the preview panel for progress.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isGenerating = generated && generated.status_url;

  return (
    <div className="flex flex-col gap-6">
      {/* Agent Persona */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            Describe your agent
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Label htmlFor="prompt">What should this agent do?</Label>
            <Textarea
              id="prompt"
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Create an AI receptionist for a dental clinic that books appointments, qualifies leads, and routes to HubSpot."
              className="mt-1.5"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Industry Template</Label>
              <select
                className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={templateSlug ?? ''}
                onChange={(e) => setTemplate(e.target.value || null)}
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
              <Input className="mt-1.5" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Smile Dental Clinic" />
            </div>
            <div className="col-span-2">
              <Label>Timezone</Label>
              <Input className="mt-1.5" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="America/Los_Angeles" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Call Direction */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-primary" />
            Call Direction
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {([
              { value: 'inbound', label: 'Inbound only', icon: PhoneIncoming },
              { value: 'outbound', label: 'Outbound only', icon: PhoneOutgoing },
              { value: 'both', label: 'Both directions', icon: Phone },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setCallDirection(value)}
                className={`flex flex-col items-center gap-2 rounded-lg border p-4 text-sm transition-colors ${
                  callDirection === value
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <Icon className="h-5 w-5" />
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {callDirection === 'inbound' && 'Agent receives calls from customers via your phone number.'}
            {callDirection === 'outbound' && 'Agent initiates outbound calls, e.g., reminders or campaigns.'}
            {callDirection === 'both' && 'Agent handles both inbound reception and outbound campaigns.'}
          </p>
        </CardContent>
      </Card>

      {/* CRM Connections */}
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
                  if (crmProviders.includes(p)) {
                    setCrmProviders(crmProviders.filter(c => c !== p));
                  } else {
                    setCrmProviders([...crmProviders, p]);
                  }
                }}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  crmProviders.includes(p)
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

      {/* Voice Config */}
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
                value={voiceConfig?.stt_model ?? 'nova-3'}
                onChange={(e) => setVoiceConfig({ ...(voiceConfig ?? {}), stt_model: e.target.value })}
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
                value={voiceConfig?.tts_voice ?? 'aura-2-en-us'}
                onChange={(e) => setVoiceConfig({ ...(voiceConfig ?? {}), tts_voice: e.target.value })}
              >
                <option value="aura-2-en-us">Aura-2 US English (default)</option>
                <option value="aura-2-en-au">Aura-2 Australian English</option>
                <option value="aura-2-en-gb">Aura-2 British English</option>
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={prompt.length < 10 || generateMutation.isPending}
          className="gap-2"
        >
          <Sparkles className="h-4 w-4" />
          {generateMutation.isPending ? 'Starting generation…' : 'Generate Agent'}
        </Button>
        {!isGenerating && draftSpec && (
          <p className="text-xs text-muted-foreground">Generation complete — preview in right panel.</p>
        )}
      </div>
    </div>
  );
}