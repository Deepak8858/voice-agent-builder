'use client';

import { useQuery } from '@tanstack/react-query';
import type { ImprovementSuggestionsResponse } from '@voiceforge/shared';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/use-api';
import { Lightbulb, AlertTriangle, Info, XCircle } from 'lucide-react';

interface SuggestionsPanelProps {
  workspaceId: string;
  agentId: string;
}

const SEVERITY_ICONS = {
  info: Info,
  warning: AlertTriangle,
  critical: XCircle,
};

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  critical: 'bg-red-500/10 text-red-600 dark:text-red-400',
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
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" />
          Suggestions
        </CardTitle>
        <Badge variant="secondary">{data.data?.suggestions.length ?? 0}</Badge>
      </CardHeader>
      <CardContent>
        {data.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.data?.suggestions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No issues spotted. The agent looks healthy.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.data?.suggestions.map((s) => {
              const Icon = SEVERITY_ICONS[s.severity as keyof typeof SEVERITY_ICONS] ?? Info;
              return (
                <li
                  key={s.code}
                  className="rounded-lg border border-border bg-background p-3 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">{s.title}</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wide font-semibold ${
                        SEVERITY_STYLES[s.severity] ?? SEVERITY_STYLES.info
                      }`}
                    >
                      <Icon className="h-3 w-3" />
                      {s.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{s.detail}</p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
