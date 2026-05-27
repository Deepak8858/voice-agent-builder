import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface StatCardProps {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'info' | 'danger';
  className?: string;
}

const toneClass: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: 'bg-primary/10 text-primary',
  success: 'bg-emerald-500/10 text-emerald-700',
  warning: 'bg-amber-500/10 text-amber-700',
  info: 'bg-sky-500/10 text-sky-700',
  danger: 'bg-destructive/10 text-destructive',
};

export function StatCard({
  label,
  value,
  description,
  icon,
  tone = 'default',
  className,
}: StatCardProps) {
  return (
    <Card className={cn('overflow-hidden bg-card/90 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md', className)}>
      <CardContent className="relative p-5">
        <div className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-primary/20 to-transparent" />
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
            <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">{value}</div>
          </div>
          {icon ? (
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl', toneClass[tone])}>
              {icon}
            </div>
          ) : (
            <ArrowUpRight className="h-4 w-4 text-muted-foreground/50" />
          )}
        </div>
        {description ? <p className="mt-3 text-sm leading-5 text-muted-foreground">{description}</p> : null}
      </CardContent>
    </Card>
  );
}
