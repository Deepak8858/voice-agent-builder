'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FlowTopBarProps {
  agentName?: string;
  backHref: string;
  nodeCount: number;
  edgeCount: number;
  issues: string[];
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onNavigateAway: (event: React.MouseEvent) => void;
}

/**
 * Top bar for the full-screen builder: back navigation, agent name, unsaved
 * indicator, validation summary popover, and the Save action.
 */
export function FlowTopBar({
  agentName,
  backHref,
  nodeCount,
  edgeCount,
  issues,
  isDirty,
  isSaving,
  onSave,
  onNavigateAway,
}: FlowTopBarProps) {
  const [showIssues, setShowIssues] = useState(false);
  const hasIssues = issues.length > 0;

  return (
    <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-2.5">
      <Button asChild variant="ghost" size="sm" className="shrink-0">
        <Link href={backHref} onClick={onNavigateAway}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />
          Builder
        </Link>
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-foreground">
            {agentName ?? 'Conversation flow'}
          </h1>
          {isDirty ? (
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {nodeCount} nodes · {edgeCount} connections
        </p>
      </div>

      <div className="relative shrink-0">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={hasIssues ? 'text-amber-600' : 'text-emerald-600'}
          onClick={() => setShowIssues((open) => hasIssues && !open)}
          aria-expanded={showIssues && hasIssues}
        >
          {hasIssues ? (
            <>
              <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
              {issues.length} issue{issues.length === 1 ? '' : 's'}
            </>
          ) : (
            <>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              Valid
            </>
          )}
        </Button>
        {showIssues && hasIssues ? (
          <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg">
            <p className="mb-2 text-xs font-semibold text-foreground">Fix these before saving</p>
            <ul className="flex max-h-64 list-disc flex-col gap-1.5 overflow-y-auto pl-4">
              {issues.map((issue) => (
                <li key={issue} className="text-[11px] leading-relaxed text-muted-foreground">
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Button
        type="button"
        size="sm"
        className="shrink-0"
        onClick={onSave}
        disabled={isSaving || hasIssues}
        title={hasIssues ? 'Resolve validation issues before saving' : 'Save flow (Ctrl+S)'}
      >
        {isSaving ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="mr-1.5 h-3.5 w-3.5" />
        )}
        Save
      </Button>
    </header>
  );
}
