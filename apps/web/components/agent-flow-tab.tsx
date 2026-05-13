'use client';

import { useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { FlowBuilderClient } from '@/components/flow-builder/flow-builder-client';

interface AgentFlowTabProps {
  workspaceId: string;
  agentId: string;
  initialFlow?: { nodes: Node[]; edges: Edge[] };
  jsonContent?: string;
}

export function AgentFlowTab({
  workspaceId,
  agentId,
  initialFlow,
  jsonContent,
}: AgentFlowTabProps) {
  const [tab, setTab] = useState<'visual' | 'json'>('visual');

  return (
    <div className="flex flex-col">
      {/* Tab toggle */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit mb-4">
        <button
          onClick={() => setTab('visual')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            tab === 'visual'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Visual Builder
        </button>
        <button
          onClick={() => setTab('json')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            tab === 'json'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          JSON Editor
        </button>
      </div>

      {tab === 'visual' ? (
        <FlowBuilderClient workspaceId={workspaceId} agentId={agentId} initialFlow={initialFlow} />
      ) : (
        <div className="rounded-xl border border-border bg-muted/50 p-4">
          <pre className="text-xs font-mono overflow-auto max-h-[600px]">
            {jsonContent ?? '// No spec saved yet'}
          </pre>
        </div>
      )}
    </div>
  );
}