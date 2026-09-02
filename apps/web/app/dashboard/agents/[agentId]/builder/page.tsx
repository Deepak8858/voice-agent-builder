import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiCallError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '@/components/ui/card';
import { AgentFlowTab } from '@/components/agent-flow-tab';
import { AgentSpecVersionEditor } from '@/components/agent-spec-version-editor';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { SuggestionsPanel } from '@/components/suggestions-panel';
import { TestCallDrawer } from '@/components/test-call-drawer';
import { PublishAgentButton } from '@/components/publish-agent-button';
import { PauseAgentButton } from '@/components/pause-agent-button';
import { PageHeader, StatCard, StatusBadge } from '@/components/dashboard';
import {
  buildDefaultAgentFlow,
  convertAgentFlowToReactFlow,
} from '@/components/flow-builder/flow-builder-model';
import type { AgentDetail, SessionUser } from '@voiceforge/shared';
import {
  ArrowLeft,
  Bot,
  Database,
  FileCode,
  GitBranch,
  Layers,
  Route,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';

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

  const workspaceId = me.active_workspace_id ?? '';
  const latestVersion = agent.versions[0];
  const builderFlow = agent.active_spec
    ? convertAgentFlowToReactFlow(agent.active_spec.flow ?? buildDefaultAgentFlow(agent.active_spec))
    : undefined;
  const flowNodeCount = builderFlow?.nodes.length ?? 0;
  const toolCount = agent.active_spec?.tools.length ?? 0;
  const knowledgeMode = agent.active_spec?.knowledge.retrieval_mode ?? 'none';

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Agent builder"
        title={agent.name}
        description={
          agent.description ??
          agent.active_spec?.description ??
          'Configure the spec, conversation flow, knowledge, tests, and deployment state for this voice agent.'
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href="/dashboard/agents">
                <ArrowLeft className="h-4 w-4" />
                Agents
              </Link>
            </Button>
            <TestCallDrawer workspaceId={workspaceId} agentId={agent.id} />
            {agent.status === 'published' ? (
              <PauseAgentButton workspaceId={workspaceId} agentId={agent.id} />
            ) : null}
            <PublishAgentButton workspaceId={workspaceId} agentId={agent.id} />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={agent.status} />
          {agent.google_sheet_url ? (
            <a
              href={agent.google_sheet_url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Google Sheet
            </a>
          ) : null}
          <span className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-medium capitalize text-muted-foreground">
            {agent.industry}
          </span>
          <span className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs font-medium capitalize text-muted-foreground">
            {humanize(agent.agent_type)}
          </span>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Lifecycle"
          value={<StatusBadge status={agent.status} />}
          description="Publish when the latest version is ready for live traffic."
          icon={<Bot className="h-5 w-5" />}
        />
        <StatCard
          label="Active version"
          value={latestVersion ? `v${latestVersion.version_number}` : '—'}
          description={latestVersion ? humanize(latestVersion.deployment_status) : 'No saved version yet'}
          icon={<Layers className="h-5 w-5" />}
          tone="info"
        />
        <StatCard
          label="Flow nodes"
          value={flowNodeCount}
          description="Visual steps in the active conversation flow."
          icon={<Waypoints className="h-5 w-5" />}
          tone="success"
        />
        <StatCard
          label="Knowledge mode"
          value={humanize(knowledgeMode)}
          description={`${toolCount} tool${toolCount === 1 ? '' : 's'} configured in the spec.`}
          icon={<Database className="h-5 w-5" />}
          tone="warning"
        />
      </div>

      <nav className="flex gap-2 overflow-x-auto rounded-2xl border border-border/80 bg-card/80 p-2 text-sm shadow-sm backdrop-blur">
        {[
          ['#flow', 'Flow'],
          ['#spec', 'Spec'],
          ['#testing', 'Testing'],
          ['#knowledge', 'Knowledge'],
          ['#versions', 'Versions'],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="shrink-0 rounded-xl px-3 py-2 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card id="flow" className="scroll-mt-24 overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              Conversation Flow
            </CardTitle>
            <CardDescription>
              Review the call path here, then open the full-screen builder to edit it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AgentFlowTab
              agentId={agent.id}
              initialFlow={builderFlow}
              jsonContent={agent.active_spec ? JSON.stringify(agent.active_spec, null, 2) : undefined}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card id="testing" className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Route className="h-4 w-4 text-primary" />
                Test & publish
              </CardTitle>
              <CardDescription>
                Run a browser test call before publishing changes to live traffic.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 sm:flex-row">
              <TestCallDrawer workspaceId={workspaceId} agentId={agent.id} />
              <PublishAgentButton workspaceId={workspaceId} agentId={agent.id} />
              {agent.status === 'published' ? (
                <PauseAgentButton workspaceId={workspaceId} agentId={agent.id} />
              ) : null}
            </CardContent>
          </Card>

          <Card id="spec" className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCode className="h-4 w-4 text-primary" />
                Agent Spec
              </CardTitle>
              <CardDescription>
                Edit validated provider-neutral configuration without changing backend contracts.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentSpecVersionEditor
                workspaceId={workspaceId}
                agentId={agent.id}
                initialSpec={agent.active_spec}
              />
            </CardContent>
          </Card>

          <Card id="versions" className="scroll-mt-24">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                Versions ({agent.versions.length})
              </CardTitle>
              <CardDescription>
                Every spec edit is saved as a new version before deployment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {agent.versions.map((v) => (
                  <li
                    key={v.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5"
                  >
                    <div>
                      <p className="font-medium text-sm text-foreground">
                        v{v.version_number}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(v.created_at).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge status={v.deployment_status} />
                  </li>
                ))}
                {agent.versions.length === 0 ? (
                  <li className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
                    No versions yet. Save a valid spec to create version history.
                  </li>
                ) : null}
              </ul>
            </CardContent>
          </Card>

          <div id="knowledge" className="scroll-mt-24">
            <KnowledgePanel workspaceId={workspaceId} agentId={agent.id} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                Launch checklist
              </CardTitle>
              <CardDescription>
                Quick checks before routing real callers to this agent.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3 text-sm">
                {[
                  { label: 'Spec saved', complete: Boolean(agent.active_spec) },
                  { label: 'Conversation flow present', complete: flowNodeCount > 0 },
                  { label: 'Compliance configured', complete: Boolean(agent.active_spec?.compliance) },
                  { label: 'Handoff policy reviewed', complete: Boolean(agent.active_spec?.handoff) },
                ].map(({ label, complete }) => (
                  <li key={label} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <StatusBadge status={complete ? 'ready' : 'pending'} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <SuggestionsPanel workspaceId={workspaceId} agentId={agent.id} />
        </div>
      </div>
    </div>
  );
}

function humanize(value: string): string {
  return value.replace(/_/g, ' ');
}
