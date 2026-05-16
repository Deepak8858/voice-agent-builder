'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Code,
  FormInput,
  Mic,
  Target,
  Shield,
  MessageSquare,
  Settings2,
  Plus,
  X,
  Eye,
} from 'lucide-react';

interface FormModeEditorProps {
  /** Current spec JSON */
  spec: Record<string, unknown>;
  /** Called when spec changes via form edits */
  onChange: (spec: Record<string, unknown>) => void;
  /** Whether to default to form mode */
  defaultMode?: 'json' | 'form';
}

type EditorMode = 'json' | 'form';

interface SpecSectionProps {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}

function SpecSection({ icon: Icon, title, description, children }: SpecSectionProps) {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="font-medium text-sm">{title}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children}
    </div>
  );
}

export function FormModeEditor({ spec, onChange, defaultMode = 'form' }: FormModeEditorProps) {
  const [mode, setMode] = useState<EditorMode>(defaultMode);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(spec, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const updateField = (path: string, value: unknown) => {
    const newSpec = { ...spec };
    const parts = path.split('.');
    let current = newSpec as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
    onChange(newSpec);
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    setJsonError(null);
    try {
      const parsed = JSON.parse(text);
      onChange(parsed);
    } catch (err) {
      setJsonError((err as Error).message);
    }
  };

  const identity = (spec['identity'] as Record<string, unknown>) ?? {};
  const voice = (spec['voice'] as Record<string, unknown>) ?? {};
  const goals = (spec['goals'] as string[]) ?? [];
  const compliance = (spec['compliance'] as Record<string, unknown>) ?? {};
  const conversationRules = (spec['conversation_rules'] as Record<string, unknown>) ?? {};

  return (
    <div className="flex flex-col gap-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-2">
        <Button
          variant={mode === 'form' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('form')}
          className="gap-1.5"
        >
          <FormInput className="h-3.5 w-3.5" />
          Form
        </Button>
        <Button
          variant={mode === 'json' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('json')}
          className="gap-1.5"
        >
          <Code className="h-3.5 w-3.5" />
          JSON
        </Button>
        <Badge variant="outline" className="text-xs">
          {mode === 'form' ? 'Form mode — click fields to edit' : 'JSON mode — raw spec'}
        </Badge>
      </div>

      {mode === 'form' ? (
        <div className="flex flex-col gap-4">
          {/* Identity */}
          <SpecSection icon={FormInput} title="Identity" description="Agent name, business, and disclosure">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Agent Name</Label>
                <Input
                  className="mt-1 h-8 text-sm"
                  value={(identity['agent_name'] as string) ?? ''}
                  onChange={(e) => updateField('identity.agent_name', e.target.value)}
                  placeholder="Alex"
                />
              </div>
              <div>
                <Label className="text-xs">Business Name</Label>
                <Input
                  className="mt-1 h-8 text-sm"
                  value={(identity['business_name'] as string) ?? ''}
                  onChange={(e) => updateField('identity.business_name', e.target.value)}
                  placeholder="Smile Dental"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">AI Disclosure</Label>
              <Input
                className="mt-1 h-8 text-sm"
                value={(identity['ai_disclosure'] as string) ?? ''}
                onChange={(e) => updateField('identity.ai_disclosure', e.target.value)}
                placeholder="This call may be recorded for quality assurance."
              />
            </div>
          </SpecSection>

          {/* Voice */}
          <SpecSection icon={Mic} title="Voice" description="Tone, speaking rate, and voice selection">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Tone</Label>
                <select
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={(voice['tone'] as string) ?? 'friendly'}
                  onChange={(e) => updateField('voice.tone', e.target.value)}
                >
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="warm">Warm</option>
                  <option value="casual">Casual</option>
                  <option value="formal">Formal</option>
                </select>
              </div>
              <div>
                <Label className="text-xs">Speaking Rate</Label>
                <Input
                  className="mt-1 h-8 text-sm"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="2"
                  value={(voice['speaking_rate'] as number) ?? 1.0}
                  onChange={(e) => updateField('voice.speaking_rate', parseFloat(e.target.value))}
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Voice Provider</Label>
              <select
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                value={(voice['voice_provider'] as string) ?? 'vapi'}
                onChange={(e) => updateField('voice.voice_provider', e.target.value)}
              >
                <option value="vapi">Vapi</option>
                <option value="twilio">Twilio</option>
              </select>
            </div>
          </SpecSection>

          {/* Goals */}
          <SpecSection icon={Target} title="Goals" description="What the agent should accomplish">
            <div className="space-y-2">
              {goals.map((goal, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="flex-1 h-8 text-sm"
                    value={goal}
                    onChange={(e) => {
                      const newGoals = [...goals];
                      newGoals[i] = e.target.value;
                      updateField('goals', newGoals);
                    }}
                    placeholder="Book appointments"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      const newGoals = goals.filter((_, idx) => idx !== i);
                      updateField('goals', newGoals);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => updateField('goals', [...goals, ''])}
              >
                <Plus className="h-3.5 w-3.5" />
                Add goal
              </Button>
            </div>
          </SpecSection>

          {/* Compliance */}
          <SpecSection icon={Shield} title="Compliance" description="Consent, DNC, and disclosure settings">
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'consent_required_for_outbound', label: 'Consent required (outbound)' },
                { key: 'opt_out_enabled', label: 'Opt-out detection' },
                { key: 'dnc_check_enabled', label: 'DNC list check' },
                { key: 'recording_notice_required', label: 'Recording notice' },
              ].map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded border-border"
                    checked={(compliance[key] as boolean) ?? false}
                    onChange={(e) => updateField(`compliance.${key}`, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </SpecSection>

          {/* First Message */}
          <SpecSection icon={MessageSquare} title="First Message" description="Opening greeting">
            <Textarea
              className="min-h-[80px] text-sm"
              value={(spec['first_message'] as string) ?? ''}
              onChange={(e) => updateField('first_message', e.target.value)}
              placeholder="Hello, you've reached [Business]. How can I help you today?"
            />
          </SpecSection>

          {/* Conversation Rules */}
          <SpecSection icon={Settings2} title="Conversation Rules" description="How the agent handles conversation">
            <div className="grid grid-cols-2 gap-3">
              {[
                { key: 'interruptions_enabled', label: 'Allow interruptions' },
                { key: 'transfer_enabled', label: 'Enable transfers' },
                { key: 'sentiment_detection', label: 'Sentiment detection' },
                { key: 'callback_offer_on_negative', label: 'Offer callback on negative sentiment' },
              ].map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded border-border"
                    checked={(conversationRules[key] as boolean) ?? false}
                    onChange={(e) => updateField(`conversation_rules.${key}`, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </SpecSection>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Agent Spec JSON</Label>
            <Button variant="ghost" size="sm" className="gap-1.5 h-7" onClick={() => setJsonText(JSON.stringify(spec, null, 2))}>
              <Eye className="h-3 w-3" />
              Reset
            </Button>
          </div>
          <Textarea
            className="font-mono text-xs min-h-[500px]"
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
          />
          {jsonError && (
            <p className="text-xs text-destructive">JSON error: {jsonError}</p>
          )}
        </div>
      )}
    </div>
  );
}