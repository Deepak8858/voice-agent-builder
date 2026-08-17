'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Edge, Node } from '@xyflow/react';
import { Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FlowPreview } from '@/components/flow-builder/flow-preview';

interface AgentFlowTabProps {
  agentId: string;
  initialFlow?: { nodes: Node[]; edges: Edge[] };
  jsonContent?: string;
}

export function AgentFlowTab({ agentId, initialFlow, jsonContent }: AgentFlowTabProps) {
  const [tab, setTab] = useState<'visual' | 'json'>('visual');

  return (
    <div className="flex flex-col">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setTab('visual')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'visual'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Flow preview
          </button>
          <button
            type="button"
            onClick={() => setTab('json')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'json'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            JSON Editor
          </button>
        </div>

        <Button asChild size="sm" className="gap-1.5">
          <Link href={`/dashboard/agents/${agentId}/flow`}>
            <Maximize2 className="h-3.5 w-3.5" />
            Open flow builder
          </Link>
        </Button>
      </div>

      {tab === 'visual' ? (
        <FlowPreview flow={initialFlow} />
      ) : (
        <div className="ph-no-capture rounded-xl border border-border bg-muted/50 p-4">
          <pre className="max-h-[420px] overflow-auto font-mono text-xs">
            {jsonContent ?? '// No spec saved yet'}
          </pre>
        </div>
      )}
    </div>
  );
}
