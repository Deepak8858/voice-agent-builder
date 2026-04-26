'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AgentDetail,
  AgentSummary,
  GenerateAgentResult,
  KnowledgeSourceSummary,
  SessionUser,
} from '@voiceforge/shared';
import { Button } from '@/components/ui/button';
import { Card, CardTitle, Input, Label, Select, Textarea, Badge } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';
import { useAgentDraftStore } from '@/lib/stores/agent-draft';

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 items-center justify-center text-sm text-zinc-500">
      Loading editor\u2026
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
      return call<GenerateAgentResult>(
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
    },
    onSuccess: (res) => {
      draft.setGenerated(res);
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
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          New agent
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Describe what the agent should do. VoiceForge generates a full Agent Spec JSON
          you can review and save as a draft.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card className="flex flex-col gap-4">
          <CardTitle>Describe your agent</CardTitle>
          <div>
            <Label htmlFor="prompt">Prompt</Label>
            <Textarea
              id="prompt"
              rows={6}
              value={draft.prompt}
              onChange={(e) => draft.setPrompt(e.target.value)}
              placeholder="Create an AI receptionist for a dental clinic that books appointments and transfers emergencies."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Template</Label>
              <Select
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
              </Select>
            </div>
            <div>
              <Label>Business name</Label>
              <Input
                value={draft.businessName}
                onChange={(e) => draft.setBusinessName(e.target.value)}
                placeholder="Smile Dental Clinic"
              />
            </div>
            <div className="col-span-2">
              <Label>Timezone</Label>
              <Input
                value={draft.timezone}
                onChange={(e) => draft.setTimezone(e.target.value)}
                placeholder="America/Los_Angeles"
              />
            </div>
            <div className="col-span-2">
              <Label>Workspace knowledge (optional)</Label>
              {knowledgeQuery.data && knowledgeQuery.data.items.length > 0 ? (
                <ul className="space-y-1 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                  {knowledgeQuery.data.items.map((k) => (
                    <li key={k.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.knowledgeSourceIds.includes(k.id)}
                        onChange={() => draft.toggleKnowledgeSourceId(k.id)}
                      />
                      <span className="truncate">
                        {k.title}{' '}
                        <span className="text-xs text-zinc-500">
                          ({k.source_type} · {k.chunk_count} chunks)
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-zinc-500">
                  No workspace-level knowledge sources yet. Add them from the builder page
                  after creating the agent, or via a future Knowledge admin screen.
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={draft.prompt.length < 10 || generateMutation.isPending}
            >
              {generateMutation.isPending ? 'Generating\u2026' : 'Generate agent'}
            </Button>
            <Button variant="ghost" onClick={() => draft.reset()}>
              Reset
            </Button>
          </div>
        </Card>

        <Card className="flex min-h-[28rem] flex-col gap-3">
          <div className="flex items-center justify-between">
            <CardTitle>Agent Spec JSON</CardTitle>
            {draft.generated?.matched_template_slug ? (
              <Badge>matched: {draft.generated.matched_template_slug}</Badge>
            ) : null}
          </div>
          {draft.draftSpec ? (
            <>
              <div className="min-h-72 flex-1 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
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
                <p className="text-xs text-zinc-500">{draft.generated.rationale}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={createMutation.isPending || !workspaceId}
                >
                  {createMutation.isPending ? 'Saving\u2026' : 'Save as draft'}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-zinc-200 p-10 text-center text-sm text-zinc-500 dark:border-zinc-800">
              Your generated Agent Spec JSON will appear here.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
