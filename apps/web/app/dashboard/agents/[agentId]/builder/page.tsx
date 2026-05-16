import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, ApiCallError } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { FlowBuilderClient } from '@/components/flow-builder/flow-builder-client';
import { AgentFlowTab } from '@/components/agent-flow-tab';
import { KnowledgePanel } from '@/components/knowledge-panel';
import { SuggestionsPanel } from '@/components/suggestions-panel';
import { TestCallDrawer } from '@/components/test-call-drawer';
import type { Node, Edge } from '@xyflow/react';
import type { AgentDetail, SessionUser } from '@voiceforge/shared';
import { ArrowLeft, Bot, Rocket, FileCode, Layers, Sparkles, Radio, GitBranch } from 'lucide-react';

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
          <TestCallDrawer workspaceId={me.active_workspace_id ?? ''} agentId={agent.id} />
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
              <GitBranch className="h-4 w-4 text-primary" />
              Conversation Flow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <AgentFlowTab
              workspaceId={me.active_workspace_id ?? ''}
              agentId={agent.id}
              initialFlow={
                agent.active_spec?.flow
                  ? convertFlowNodes(agent.active_spec.flow as { nodes: unknown[] })
                  : undefined
              }
              jsonContent={agent.active_spec ? JSON.stringify(agent.active_spec, null, 2) : undefined}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileCode className="h-4 w-4 text-primary" />
                Agent Spec JSON
              </CardTitle>
            </CardHeader>
            <CardContent>
              {agent.active_spec ? (
                <pre className="max-h-[20rem] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed font-mono">
                  {JSON.stringify(agent.active_spec, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No active version. Save a draft spec first.</p>
              )}
            </CardContent>
          </Card>

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

          <KnowledgePanel workspaceId={me.active_workspace_id ?? ''} agentId={agent.id} />

          <SuggestionsPanel workspaceId={me.active_workspace_id ?? ''} agentId={agent.id} />
        </div>
      </div>
    </div>
  );
}

/**
 * Convert spec-style flow nodes (from AgentSpec) to React Flow nodes.
 * Spec nodes: { id, type, text, question, expression, on_true, on_false, ... }
 * React Flow nodes: { id, type, position, data }
 */
function convertFlowNodes(flow: { nodes: unknown[] }): { nodes: Node[]; edges: Edge[] } {
  const map: Record<string, Node> = {};
  const edges: Edge[] = [];

  for (const node of flow.nodes as Array<{ id: string; type: string; [key: string]: unknown }>) {
    const rfNode: Node = {
      id: node.id,
      type: node.type === 'ask_question' ? 'ask_question'
        : node.type === 'tool_call' ? 'tool_call'
        : node.type === 'send_message' ? 'speak'
        : node.type,
      position: { x: Math.random() * 400 + 100, y: Object.keys(map).length * 150 },
      data: {
        label: node.type === 'start' ? 'Start' : node.type === 'end' ? 'End' : '',
        ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'id' && k !== 'type')),
      },
    };
    map[node.id] = rfNode;
  }

  // Create edges from `next` / `on_true` / `on_false` fields
  for (const node of flow.nodes as Array<{ id: string; next?: string; on_true?: string; on_false?: string }>) {
    if (node.next && map[node.next]) {
      edges.push({ id: `e-${node.id}-${node.next}`, source: node.id, target: node.next, animated: true });
    }
    if (node.on_true && map[node.on_true]) {
      edges.push({ id: `e-${node.id}-true-${node.on_true}`, source: node.id, target: node.on_true, sourceHandle: 'true', animated: true });
    }
    if (node.on_false && map[node.on_false]) {
      edges.push({ id: `e-${node.id}-false-${node.on_false}`, source: node.id, target: node.on_false, sourceHandle: 'false', animated: true });
    }
  }

  return { nodes: Object.values(map), edges };
}
