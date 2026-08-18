'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export interface NodeCardTheme {
  border: string;
  bg: string;
  icon: string;
  title: string;
  text: string;
  handle: string;
}

interface NodeCardProps {
  icon: LucideIcon;
  title: string;
  theme: NodeCardTheme;
  /** One-line content preview rendered as plain text. */
  preview?: string;
  previewMono?: boolean;
  /** Shows an amber validation dot when the node config is incomplete. */
  incomplete?: boolean;
  selected?: boolean;
  children?: React.ReactNode;
}

/**
 * Shared visual shell for flow nodes: lucide icon, color-coded card, title,
 * one-line preview, and a validation dot for incomplete configuration.
 * Content is always rendered as React text (never HTML) since previews can
 * come from AI-generated specs.
 */
export function NodeCard({
  icon: Icon,
  title,
  theme,
  preview,
  previewMono = false,
  incomplete = false,
  selected = false,
  children,
}: NodeCardProps) {
  return (
    <div
      className={cn(
        'w-[230px] rounded-xl border-2 px-3.5 py-2.5 shadow-sm transition-shadow',
        theme.border,
        theme.bg,
        selected && 'shadow-md ring-2 ring-ring ring-offset-1',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md', theme.icon)}>
          <Icon className="h-3.5 w-3.5" aria-hidden />
        </span>
        <p className={cn('min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide', theme.title)}>
          {title}
        </p>
        {incomplete ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
            title="Configuration incomplete"
            aria-label="Configuration incomplete"
          />
        ) : null}
      </div>
      {preview !== undefined ? (
        <p
          className={cn(
            'mt-1.5 truncate text-sm',
            theme.text,
            previewMono && 'font-mono text-xs',
          )}
        >
          {preview}
        </p>
      ) : null}
      {children}
    </div>
  );
}
