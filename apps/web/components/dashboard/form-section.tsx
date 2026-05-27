import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface FormSectionProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function FormSection({
  icon,
  title,
  description,
  children,
  footer,
  className,
}: FormSectionProps) {
  return (
    <Card className={cn('overflow-hidden bg-card/95 shadow-sm', className)}>
      <CardHeader className="border-b border-border/70 bg-muted/25">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon ? (
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-primary">
              {icon}
            </span>
          ) : null}
          {title}
        </CardTitle>
        {description ? <CardDescription className="max-w-2xl leading-6">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="p-5 sm:p-6">{children}</CardContent>
      {footer ? <div className="border-t border-border/70 bg-muted/20 px-5 py-4 sm:px-6">{footer}</div> : null}
    </Card>
  );
}
