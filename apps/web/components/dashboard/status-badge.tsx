import { Circle, Radio, AlertTriangle, Pause, Archive, CheckCircle2, Clock3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

interface StatusBadgeProps {
  status: string;
  className?: string;
}

function statusMeta(status: string) {
  const normalized = status.toLowerCase().replace(/\s+/g, '_');
  if (['published', 'active', 'completed', 'deployed', 'ready', 'enabled', 'running'].includes(normalized)) {
    return {
      label: normalized === 'published' ? 'Active' : normalized.replace(/_/g, ' '),
      icon: CheckCircle2,
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300',
    };
  }
  if (['draft', 'queued', 'pending', 'not_deployed'].includes(normalized)) {
    return {
      label: normalized.replace(/_/g, ' '),
      icon: Clock3,
      className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300',
    };
  }
  if (['testing', 'in_progress', 'processing', 'deploying', 'ringing'].includes(normalized)) {
    return {
      label: normalized.replace(/_/g, ' '),
      icon: Radio,
      className: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-300',
    };
  }
  if (['paused', 'cancelled', 'disabled'].includes(normalized)) {
    return {
      label: normalized.replace(/_/g, ' '),
      icon: Pause,
      className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300',
    };
  }
  if (['failed', 'error'].includes(normalized)) {
    return {
      label: normalized.replace(/_/g, ' '),
      icon: AlertTriangle,
      className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300',
    };
  }
  if (normalized === 'archived') {
    return {
      label: 'archived',
      icon: Archive,
      className: 'border-stone-200 bg-stone-50 text-stone-600 dark:border-stone-700 dark:bg-stone-900/60 dark:text-stone-400',
    };
  }
  return {
    label: normalized.replace(/_/g, ' '),
    icon: Circle,
    className: 'border-border bg-secondary text-secondary-foreground',
  };
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const meta = statusMeta(status);
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn('gap-1.5 capitalize shadow-none', meta.className, className)}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}
