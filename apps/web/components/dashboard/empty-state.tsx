import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  className,
}: EmptyStateProps) {
  const action =
    actionLabel && actionHref ? (
      <Button asChild size="lg" className="mt-2 gap-2">
        <Link href={actionHref}>
          {actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    ) : null;

  return (
    <Card
      className={cn(
        'relative overflow-hidden border-dashed bg-card/80 px-6 py-16 text-center shadow-sm',
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        {icon ? (
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary shadow-sm">
            {icon}
          </div>
        ) : null}
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
    </Card>
  );
}
