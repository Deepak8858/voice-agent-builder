'use client';

import { useQuery } from '@tanstack/react-query';
import type { ImprovementSuggestionsResponse } from '@voiceforge/shared';
import { Badge, Card, CardHeader, CardTitle } from '@/components/ui/primitives';
import { useApi } from '@/lib/use-api';

interface SuggestionsPanelProps {
  workspaceId: string;
  agentId: string;
}

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export function SuggestionsPanel({ workspaceId, agentId }: SuggestionsPanelProps) {
  const { call } = useApi();
  const data = useQuery({
    queryKey: ['suggestions', workspaceId, agentId],
    queryFn: () =>
      call<ImprovementSuggestionsResponse>(
        `/workspaces/${workspaceId}/analytics/agents/${agentId}/suggestions`,
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggestions</CardTitle>
        <Badge>{data.data?.suggestions.length ?? 0}</Badge>
      </CardHeader>
      {data.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : data.data?.suggestions.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No issues spotted. The agent looks healthy.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.data?.suggestions.map((s) => (
            <li
              key={s.code}
              className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {s.title}
                </span>
                <span
                  className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                    SEVERITY_STYLES[s.severity] ?? SEVERITY_STYLES.info
                  }`}
                >
                  {s.severity}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {s.detail}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
