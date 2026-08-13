'use client';

import { useEffect, useMemo, useState, type ElementType, type ReactNode } from 'react';
import {
  AgentSpecSchema,
  setAgentSpecPath,
  summarizeAgentSpecIssues,
  type AgentSpec,
} from '@voiceforge/shared';
import {
  AlertCircle,
  CheckCircle2,
  Code,
  Eye,
  FormInput,
  MessageSquare,
  Mic,
  Plus,
  Shield,
  Target,
  UserRound,
  Workflow,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type EditorMode = 'json' | 'form';

export interface AgentSpecValidationState {
  isValid: boolean;
  issues: string[];
  parsedSpec: AgentSpec | null;
}

interface FormModeEditorProps {
  spec: unknown;
  onChange: (spec: unknown) => void;
  defaultMode?: EditorMode;
  onValidationChange?: (state: AgentSpecValidationState) => void;
}

interface SpecSectionProps {
  icon: ElementType;
  title: string;
  description: string;
  children: ReactNode;
}

const AGENT_TYPES = [
  'inbound_receptionist',
  'outbound_reminder',
  'outbound_qualifier',
  'outbound_confirmation',
  'outbound_survey',
] as const;

function SpecSection({ icon: Icon, title, description, children }: SpecSectionProps) {
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function FormModeEditor({
  spec,
  onChange,
  defaultMode = 'form',
  onValidationChange,
}: FormModeEditorProps) {
  const [mode, setMode] = useState<EditorMode>(defaultMode);
  const [jsonText, setJsonText] = useState(() => stringifySpec(spec));
  const [jsonError, setJsonError] = useState<string | null>(null);

  const validation = useMemo<AgentSpecValidationState>(() => {
    const parsed = AgentSpecSchema.safeParse(spec);
    if (parsed.success) {
      return { isValid: true, issues: [], parsedSpec: parsed.data };
    }
    return {
      isValid: false,
      issues: summarizeAgentSpecIssues(parsed.error),
      parsedSpec: null,
    };
  }, [spec]);

  useEffect(() => {
    onValidationChange?.(validation);
  }, [onValidationChange, validation]);

  useEffect(() => {
    if (mode === 'form') {
      setJsonText(stringifySpec(spec));
      setJsonError(null);
    }
  }, [mode, spec]);

  const specRecord = asRecord(spec);
  const identity = asRecord(specRecord.identity);
  const voice = asRecord(specRecord.voice);
  const compliance = asRecord(specRecord.compliance);
  const conversationRules = asRecord(specRecord.conversation_rules);
  const handoff = asRecord(specRecord.handoff);
  const analytics = asRecord(specRecord.analytics);
  const goals = getStringArray(specRecord.goals);
  const handoffConditions = getStringArray(handoff.conditions);
  const successEvents = getStringArray(analytics.success_events);

  const updateField = (path: string, value: unknown) => {
    onChange(setAgentSpecPath(specRecord, path, value));
  };

  const updateStringArray = (path: string, values: string[]) => {
    updateField(path, values);
  };

  const switchMode = (nextMode: EditorMode) => {
    if (nextMode === 'json') {
      setJsonText(stringifySpec(spec));
      setJsonError(null);
    }
    setMode(nextMode);
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      setJsonError(null);
      onChange(parsed);
    } catch (err) {
      setJsonError((err as Error).message);
    }
  };

  return (
    /*
     * ph-no-capture: both editor modes render the Agent Spec, which contains
     * system prompts, business details and handoff phone numbers.
     */
    <div className="ph-no-capture flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={mode === 'form' ? 'default' : 'outline'}
          size="sm"
          onClick={() => switchMode('form')}
          className="gap-1.5"
        >
          <FormInput className="h-3.5 w-3.5" />
          Form
        </Button>
        <Button
          type="button"
          variant={mode === 'json' ? 'default' : 'outline'}
          size="sm"
          onClick={() => switchMode('json')}
          className="gap-1.5"
        >
          <Code className="h-3.5 w-3.5" />
          JSON
        </Button>
        <Badge variant={validation.isValid ? 'secondary' : 'destructive'} className="gap-1 text-xs">
          {validation.isValid ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <AlertCircle className="h-3 w-3" />
          )}
          {validation.isValid ? 'Valid Agent Spec' : `${validation.issues.length} validation issue${validation.issues.length === 1 ? '' : 's'}`}
        </Badge>
      </div>

      {!validation.isValid ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <p className="font-medium">Fix these Agent Spec fields before saving.</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {validation.issues.slice(0, 5).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {validation.issues.length > 5 ? (
            <p className="mt-2 text-destructive/80">
              {validation.issues.length - 5} more issue{validation.issues.length - 5 === 1 ? '' : 's'} in JSON mode.
            </p>
          ) : null}
        </div>
      ) : null}

      {mode === 'form' ? (
        <div className="flex flex-col gap-4">
          <SpecSection icon={UserRound} title="Basics" description="Agent metadata used for creation, routing, and version display.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Agent name</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(specRecord.name)}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder="Dental Receptionist"
                />
              </div>
              <div>
                <Label className="text-xs">Industry</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(specRecord.industry)}
                  onChange={(e) => updateField('industry', e.target.value)}
                  placeholder="healthcare"
                />
              </div>
              <div>
                <Label className="text-xs">Agent type</Label>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={getAgentType(specRecord.agent_type)}
                  onChange={(e) => updateField('agent_type', e.target.value)}
                >
                  <option value="" disabled>
                    Select type
                  </option>
                  {AGENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">Language</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(specRecord.language)}
                  onChange={(e) => updateField('language', e.target.value)}
                  placeholder="en"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Textarea
                className="mt-1 min-h-20 text-sm"
                value={getString(specRecord.description)}
                onChange={(e) => updateField('description', e.target.value)}
                placeholder="Short internal summary of this agent."
              />
            </div>
          </SpecSection>

          <SpecSection icon={FormInput} title="Identity" description="How the agent introduces itself and the business.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Business name</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(identity.business_name)}
                  onChange={(e) => updateField('identity.business_name', e.target.value)}
                  placeholder="Smile Dental Clinic"
                />
              </div>
              <div>
                <Label className="text-xs">Agent display name</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(identity.agent_name)}
                  onChange={(e) => updateField('identity.agent_name', e.target.value)}
                  placeholder="Ava"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Disclosure line</Label>
              <Input
                className="mt-1 h-9 text-sm"
                value={getString(identity.disclosure)}
                onChange={(e) => updateField('identity.disclosure', e.target.value)}
                placeholder="I am an AI assistant calling on behalf of Smile Dental Clinic."
              />
            </div>
          </SpecSection>

          <SpecSection icon={Mic} title="Voice" description="Provider-neutral voice behavior. Provider adapter selection stays outside the spec.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Tone</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(voice.tone)}
                  onChange={(e) => updateField('voice.tone', e.target.value)}
                  placeholder="friendly and professional"
                />
              </div>
              <div>
                <Label className="text-xs">Voice ID</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  value={getString(voice.voice_id)}
                  onChange={(e) => updateField('voice.voice_id', e.target.value)}
                  placeholder="optional provider voice id"
                />
              </div>
              <div>
                <Label className="text-xs">Speaking rate</Label>
                <Input
                  className="mt-1 h-9 text-sm"
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="2"
                  value={getOptionalNumberInput(voice.speaking_rate)}
                  onChange={(e) => updateField('voice.speaking_rate', toOptionalNumber(e.target.value))}
                />
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-border"
                  checked={getBoolean(voice.allow_interruptions, true)}
                  onChange={(e) => updateField('voice.allow_interruptions', e.target.checked)}
                />
                Allow interruptions
              </label>
            </div>
          </SpecSection>

          <SpecSection icon={Target} title="Goals" description="The outcomes this agent should optimize for.">
            <StringListEditor
              values={goals}
              placeholder="Book appointments"
              addLabel="Add goal"
              onChange={(values) => updateStringArray('goals', values)}
            />
          </SpecSection>

          <SpecSection icon={MessageSquare} title="Conversation Rules" description="Runtime guardrails for how the agent speaks and recovers.">
            <div>
              <Label className="text-xs">First message</Label>
              <Textarea
                className="mt-1 min-h-20 text-sm"
                value={getString(conversationRules.first_message)}
                onChange={(e) => updateField('conversation_rules.first_message', e.target.value)}
                placeholder="Thanks for calling Smile Dental Clinic. How can I help?"
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ['ask_one_question_at_a_time', 'Ask one question at a time'],
                ['confirm_critical_information', 'Confirm critical information'],
                ['do_not_make_up_answers', 'Do not make up answers'],
                ['fallback_to_human_when_unsure', 'Fallback to human when unsure'],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded border-border"
                    checked={getBoolean(conversationRules[key], true)}
                    onChange={(e) => updateField(`conversation_rules.${key}`, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </SpecSection>

          <SpecSection icon={Shield} title="Compliance" description="Consent and disclosure controls required before calls can run.">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ['ai_disclosure_required', 'AI disclosure required'],
                ['recording_notice_required', 'Recording notice required'],
                ['opt_out_enabled', 'Opt-out enabled'],
                ['consent_required_for_outbound', 'Consent required for outbound'],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="rounded border-border"
                    checked={getBoolean(compliance[key], key !== 'recording_notice_required')}
                    onChange={(e) => updateField(`compliance.${key}`, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </SpecSection>

          <SpecSection icon={Workflow} title="Handoff" description="Human transfer behavior and escalation conditions.">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="rounded border-border"
                checked={getBoolean(handoff.enabled, true)}
                onChange={(e) => updateField('handoff.enabled', e.target.checked)}
              />
              Enable human handoff
            </label>
            <div>
              <Label className="text-xs">Target phone</Label>
              <Input
                className="mt-1 h-9 text-sm"
                value={getString(handoff.target_phone)}
                onChange={(e) => updateField('handoff.target_phone', e.target.value)}
                placeholder="+15555550100"
              />
            </div>
            <StringListEditor
              values={handoffConditions}
              placeholder="caller_requests_human"
              addLabel="Add condition"
              onChange={(values) => updateStringArray('handoff.conditions', values)}
            />
          </SpecSection>

          <SpecSection icon={CheckCircle2} title="Analytics" description="Events counted as successful outcomes.">
            <StringListEditor
              values={successEvents}
              placeholder="appointment_booked"
              addLabel="Add event"
              onChange={(values) => updateStringArray('analytics.success_events', values)}
            />
          </SpecSection>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">Agent Spec JSON</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5"
              onClick={() => {
                setJsonText(stringifySpec(spec));
                setJsonError(null);
              }}
            >
              <Eye className="h-3 w-3" />
              Reset
            </Button>
          </div>
          <Textarea
            className="min-h-[500px] font-mono text-xs"
            value={jsonText}
            onChange={(e) => handleJsonChange(e.target.value)}
          />
          {jsonError ? (
            <p className="text-xs text-destructive">JSON parse error: {jsonError}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function StringListEditor({
  values,
  placeholder,
  addLabel,
  onChange,
}: {
  values: string[];
  placeholder: string;
  addLabel: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="h-9 flex-1 text-sm"
            value={value}
            onChange={(e) => {
              const next = [...values];
              next[index] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            aria-label="Remove item"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => onChange([...values, ''])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? item : '')) : [];
}

function getBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function getOptionalNumberInput(value: unknown): number | '' {
  return typeof value === 'number' && Number.isFinite(value) ? value : '';
}

function toOptionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getAgentType(value: unknown): string {
  return typeof value === 'string' && AGENT_TYPES.includes(value as (typeof AGENT_TYPES)[number])
    ? value
    : '';
}

function stringifySpec(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}
