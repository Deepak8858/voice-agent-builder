import { notFound } from 'next/navigation';
import { apiFetch, ApiCallError, requireSessionUser } from '@/lib/api';
import { FlowBuilderClient } from '@/components/flow-builder/flow-builder-client';
import {
  buildDefaultAgentFlow,
  convertAgentFlowToReactFlow,
} from '@/components/flow-builder/flow-builder-model';
import type { AgentDetail } from '@voiceforge/shared';

interface PageProps {
  params: Promise<{ agentId: string }>;
}

export default async function AgentFlowPage({ params }: PageProps) {
  const { agentId } = await params;
  const me = await requireSessionUser(`/dashboard/agents/${agentId}/flow`);
  if (!me.active_workspace_id) notFound();

  let agent: AgentDetail;
  try {
    agent = await apiFetch<AgentDetail>(`/workspaces/${me.active_workspace_id}/agents/${agentId}`);
  } catch (err) {
    if (err instanceof ApiCallError && err.status === 404) return notFound();
    throw err;
  }

  const initialFlow = agent.active_spec
    ? convertAgentFlowToReactFlow(agent.active_spec.flow ?? buildDefaultAgentFlow(agent.active_spec))
    : undefined;

  return (
    /* Breaks out of the dashboard container so the canvas fills the viewport. */
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <FlowBuilderClient
        workspaceId={me.active_workspace_id}
        agentId={agent.id}
        agentName={agent.name}
        initialFlow={initialFlow}
      />
    </div>
  );
}
