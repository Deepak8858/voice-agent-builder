'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AgentDetail,
  AgentSummary,
  KnowledgeSourceSummary,
  SessionUser,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore } from '@/lib/stores/agent-draft';
import { Bot, Sparkles, RotateCcw, Save } from 'lucide-react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
      Loading editor…
    </div>
  ),
});

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
      if (res.spec) draft.setDraftSpec(res.spec as Parameters<typeof draft.setDraftSpec>[0]);
      toast.success('Agent Spec generated.');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId || !draft.draftSpec) throw new Error('Missing spec');
      return call<AgentDetail>(
        `/workspaces/${workspaceId}/agents`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: draft.generated?.suggested_name ?? draft.draftSpec.name,
            description: draft.generated?.rationale ?? undefined,
            industry: draft.draftSpec.industry,
            agent_type: draft.draftSpec.agent_type,
            spec: draft.draftSpec,
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
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">New agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe what the agent should do. VoiceForge generates a full Agent Spec JSON
          you can review and save as a draft.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Describe your agent
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <Label htmlFor="prompt">Prompt</Label>
                <Textarea
                  id="prompt"
                  rows={6}
                  value={draft.prompt}
                  onChange={(e) => draft.setPrompt(e.target.value)}
                  placeholder="Create an AI receptionist for a dental clinic that books appointments and transfers emergencies."
                  className="mt-1.5"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Template</Label>
                  <select
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
                  <Label>Business name</Label>
                  <Input
                    className="mt-1.5"
                    value={draft.businessName}
                    onChange={(e) => draft.setBusinessName(e.target.value)}
                    placeholder="Smile Dental Clinic"
                  />
                </div>
                <div className="col-span-2">
                  <Label>Timezone</Label>
                  <Input
                    className="mt-1.5"
                    value={draft.timezone}
                    onChange={(e) => draft.setTimezone(e.target.value)}
                    placeholder="America/Los_Angeles"
                  />
                </div>
              </div>
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
            </CardContent>
          </Card>
        </div>

        <Card className="flex min-h-[28rem] flex-col">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4 text-primary" />
              Agent Spec JSON
            </CardTitle>
            {draft.generated?.matched_template_slug ? (
              <Badge variant="secondary">matched: {draft.generated.matched_template_slug}</Badge>
            ) : null}
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-4">
            {draft.draftSpec ? (
              <>
                <div className="min-h-72 flex-1 overflow-hidden rounded-md border border-border">
                  <MonacoEditor
                    height="380px"
                    defaultLanguage="json"
                    value={JSON.stringify(draft.draftSpec, null, 2)}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 12,
                      scrollBeyondLastLine: false,
                    }}
                    theme="vs-dark"
                  />
                </div>
                {draft.generated?.rationale ? (
                  <p className="text-xs text-muted-foreground">{draft.generated.rationale}</p>
                ) : null}
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending || !workspaceId}
                    className="gap-2"
                  >
                    <Save className="h-4 w-4" />
                    {createMutation.isPending ? 'Saving…' : 'Save as draft'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                Your generated Agent Spec JSON will appear here.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}