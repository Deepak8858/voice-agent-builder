'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AgentDetail,
  AgentSummary,
  KnowledgeSourceSummary,
  SessionUser,
} from '@voiceforge/shared';
import { AgentSpecSchema } from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AgentCreationModeTabs } from '@/components/agent-creation-mode-tabs';
import { FormModeEditor, type AgentSpecValidationState } from '@/components/form-mode-editor';
import { FormSection } from '@/components/dashboard/form-section';
import { PageHeader } from '@/components/dashboard/page-header';
import { PromptQualityChecklist } from '@/components/dashboard/prompt-quality-checklist';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore } from '@/lib/stores/agent-draft';
import { Bot, Sparkles, RotateCcw, Save, Building2, BookOpen, FileJson2 } from 'lucide-react';

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  industry: string;
  agent_type: string;
}

export default function NewAgentPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { call } = useApi();

  const draft = useAgentDraftStore();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [specValidation, setSpecValidation] = useState<AgentSpecValidationState | null>(null);

  const parsedDraftSpec = useMemo(
    () => (draft.draftSpec ? AgentSpecSchema.safeParse(draft.draftSpec) : null),
    [draft.draftSpec],
  );
  const canSaveDraftSpec = Boolean(parsedDraftSpec?.success);

  useEffect(() => {
    call<SessionUser>('/auth/me')
      .then((me) => setWorkspaceId(me.active_workspace_id))
      .catch((err) => toast.error(`Session: ${err.message}`));
  }, [call]);

  useEffect(() => {
    const slug = searchParams.get('template');
    if (slug && draft.templateSlug !== slug) draft.setTemplate(slug);
  }, [searchParams, draft]);

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => call<{ items: TemplateSummary[] }>('/templates'),
  });

  const knowledgeQuery = useQuery({
    queryKey: ['knowledge-sources', 'workspace', workspaceId],
    enabled: Boolean(workspaceId),
    queryFn: () =>
      call<{ items: KnowledgeSourceSummary[] }>(
        `/workspaces/${workspaceId}/knowledge-sources?scope=workspace`,
      ),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('No active workspace');
      const res = await call<{ agent_id: string; status_url: string; spec?: unknown; suggested_name?: string; rationale?: string; matched_template_slug?: string }>(
        `/workspaces/${workspaceId}/agents/generate`,
        {
          method: 'POST',
          body: JSON.stringify({
            prompt: draft.prompt,
            template_slug: draft.templateSlug ?? undefined,
            business_context: {
              business_name: draft.businessName || undefined,
              timezone: draft.timezone || undefined,
            },
            knowledge_source_ids:
              draft.knowledgeSourceIds.length > 0 ? draft.knowledgeSourceIds : undefined,
          }),
        },
      );
      return res;
    },
    onSuccess: (res) => {
      draft.setGenerated(res as Parameters<typeof draft.setGenerated>[0]);
      if (res.spec) {
        const parsed = AgentSpecSchema.safeParse(res.spec);
        draft.setDraftSpec(parsed.success ? parsed.data : res.spec);
        if (!parsed.success) {
          toast.error('Generated spec needs validation fixes before saving.');
          return;
        }
      }
      toast.success('Agent Spec generated.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !draft.draftSpec) throw new Error('Missing spec');
      const parsed = AgentSpecSchema.safeParse(draft.draftSpec);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        const field = firstIssue?.path.length ? firstIssue.path.join('.') : 'spec';
        throw new Error(`Fix Agent Spec validation before saving: ${field}`);
      }
      const spec = parsed.data;
      return call<AgentDetail>(
        `/workspaces/${workspaceId}/agents`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: spec.name,
            description: spec.description ?? draft.generated?.rationale ?? undefined,
            industry: spec.industry,
            agent_type: spec.agent_type,
            spec,
          } satisfies { name: string; industry: string; agent_type: string; spec: unknown } & {
            description?: string;
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
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Create voice agent"
        title="Turn a phone workflow into a testable AI voice agent."
        description="Give your agent clear goals, business context, and a natural opening message. VoiceForge generates the provider-neutral Agent Spec JSON behind the scenes."
        actions={
          <Button variant="outline" onClick={() => draft.reset()} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Reset draft
          </Button>
        }
      >
        <div>
          <AgentCreationModeTabs active="spec" />
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-6">
          <FormSection
            icon={<Sparkles className="h-4 w-4" />}
            title="Agent setup"
            description="Define what the agent should do, who it represents, and which business context it can use."
          >
            <div className="flex flex-col gap-5">
              <div>
                <Label htmlFor="prompt">Prompt</Label>
                <Textarea
                  id="prompt"
                  rows={6}
                  value={draft.prompt}
                  onChange={(e) => draft.setPrompt(e.target.value)}
                  placeholder="You are a friendly customer support voice agent for {{business_name}}. Your goal is to answer questions, collect customer details, and schedule appointments. Keep responses short and natural for phone conversations."
                  className="mt-1.5 min-h-40"
                />
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Write instructions like you are training a human phone agent.</span>
                  <span className="shrink-0 font-mono">{draft.prompt.length}/4000</span>
                </div>
              </div>
              <PromptQualityChecklist prompt={draft.prompt} />
              <div className="flex items-center gap-2 border-t border-border/70 pt-2 text-sm font-semibold text-foreground">
                <Building2 className="h-4 w-4 text-primary" />
                Business context
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="template">Use case template</Label>
                  <select
                    id="template"
                    className="mt-1.5 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    value={draft.templateSlug ?? ''}
                    onChange={(e) => draft.setTemplate(e.target.value || null)}
                    disabled={templatesQuery.isPending}
                  >
                    <option value="">Auto-match from prompt</option>
                    {templatesQuery.data?.items.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="businessName">Business name</Label>
                  <Input
                    id="businessName"
                    className="mt-1.5"
                    value={draft.businessName}
                    onChange={(e) => draft.setBusinessName(e.target.value)}
                    placeholder="Smile Dental Clinic"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    className="mt-1.5"
                    value={draft.timezone}
                    onChange={(e) => draft.setTimezone(e.target.value)}
                    placeholder="America/Los_Angeles"
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <BookOpen className="h-4 w-4 text-primary" />
                  Workspace knowledge
                </div>
                {knowledgeQuery.data && knowledgeQuery.data.items.length > 0 ? (
                  <ul className="mt-2 space-y-1 rounded-xl border border-border bg-background p-3">
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
                  <p className="mt-2 rounded-xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
                    No workspace-level knowledge sources yet. Add them from the builder page
                    after creating the agent, or via the Knowledge admin screen.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 pt-2">
                <Button
                  onClick={() => generateMutation.mutate()}
                  disabled={draft.prompt.length < 10 || generateMutation.isPending}
                  className="gap-2"
                >
                  <Sparkles className="h-4 w-4" />
                  {generateMutation.isPending ? 'Generating…' : 'Generate agent'}
                </Button>
                <Button variant="outline" onClick={() => draft.reset()} className="gap-2">
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </Button>
              </div>
            </div>
          </FormSection>
        </div>

        <Card className="flex min-h-[28rem] flex-col">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileJson2 className="h-4 w-4 text-primary" />
              Review generated agent
            </CardTitle>
            {draft.generated?.matched_template_slug ? (
              <Badge variant="secondary">matched: {draft.generated.matched_template_slug}</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-4">
            {draft.draftSpec ? (
              <>
                {parsedDraftSpec?.success ? (
                  <div className="rounded-2xl border border-border bg-muted/30 p-4">
                    <p className="text-sm font-semibold text-foreground">
                      {draft.generated?.suggested_name ?? parsedDraftSpec.data.name}
                    </p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {parsedDraftSpec.data.industry} · {parsedDraftSpec.data.agent_type.replace(/_/g, ' ')} · {parsedDraftSpec.data.language}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">
                      Review the form sections, fix validation warnings, then save as a draft and test before using it with real customers.
                    </p>
                  </div>
                ) : null}
                <div className="min-h-72 flex-1">
                  <FormModeEditor
                    spec={draft.draftSpec}
                    onChange={draft.setDraftSpec}
                    defaultMode="form"
                    onValidationChange={setSpecValidation}
                  />
                </div>
                {draft.generated?.rationale ? (
                  <p className="text-xs text-muted-foreground">{draft.generated.rationale}</p>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending || !workspaceId || !canSaveDraftSpec}
                    className="gap-2"
                  >
                    <Save className="h-4 w-4" />
                    {createMutation.isPending ? 'Saving…' : 'Save as draft'}
                  </Button>
                  {specValidation && !specValidation.isValid ? (
                    <span className="text-xs text-destructive">
                      Resolve Agent Spec validation issues to save.
                    </span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
                <div className="max-w-sm">
                  <Bot className="mx-auto mb-3 h-8 w-8 text-primary" />
                  <p className="font-medium text-foreground">Your generated agent preview will appear here.</p>
                  <p className="mt-1 leading-6">
                    Complete the prompt and business context, then generate a draft Agent Spec JSON.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
