import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiCallError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { SuggestionsPanel } from '@/components/suggestions-panel';
import { TestCallDrawer } from '@/components/test-call-drawer';
import type { AgentDetail, SessionUser } from '@voiceforge/shared';
import { ArrowLeft, Bot, Rocket, FileCode, Layers, Sparkles, Radio } from 'lucide-react';

interface PageProps {
  params: Promise<{ agentId: string }>;
}

export default async function AgentBuilderPage({ params }: PageProps) {
  const { agentId } = await params;
  const me = await apiFetch<SessionUser>('/auth/me');
  let agent: AgentDetail;
  try {
    agent = await apiFetch<AgentDetail>(
      `/workspaces/${me.active_workspace_id}/agents/${agentId}`,
    );
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 404) return notFound();
    throw err;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/dashboard/agents"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-2"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to agents
          </Link>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">
            {agent.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              variant={agent.status === 'published' ? 'default' : 'secondary'}
              className="capitalize"
            >
              {agent.status}
            </Badge>
            <span className="text-sm text-muted-foreground capitalize">
              {agent.industry} &middot; {agent.agent_type.replace('_', ' ')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TestCallDrawer workspaceId={me.active_workspace_id} agentId={agent.id} />
          <Button className="gap-2">
            <Rocket className="h-4 w-4" />
            Publish
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileCode className="h-4 w-4 text-primary" />
              Agent Spec JSON
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agent.active_spec ? (
              <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed font-mono">
                {JSON.stringify(agent.active_spec, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">No active version. Save a draft spec first.</p>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                Versions ({agent.versions.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {agent.versions.map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2.5"
                  >
                    <div>
                      <p className="font-medium text-sm text-foreground">
                        v{v.version_number}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(v.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Badge variant="outline" className="capitalize">
                      {v.deployment_status.replace('_', ' ')}
                    </Badge>
                  </li>
                ))}
                {agent.versions.length === 0 ? (
                  <li className="text-xs text-muted-foreground">No versions yet.</li>
                ) : null}
              </ul>
            </CardContent>
          </Card>

          <KnowledgePanel workspaceId={me.active_workspace_id} agentId={agent.id} />

          <SuggestionsPanel workspaceId={me.active_workspace_id} agentId={agent.id} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Coming soon
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-xs text-muted-foreground">
                <li className="flex items-center gap-2">
                  <Radio className="h-3 w-3 text-primary/70" />
                  Visual flow builder
                </li>
                <li className="flex items-center gap-2">
                  <Radio className="h-3 w-3 text-primary/70" />
                  Embeddings + retrieval
                </li>
                <li className="flex items-center gap-2">
                  <Radio className="h-3 w-3 text-primary/70" />
                  Real Vapi/Retell deploy
                </li>
                <li className="flex items-center gap-2">
                  <Radio className="h-3 w-3 text-primary/70" />
                  Compliance editor
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
