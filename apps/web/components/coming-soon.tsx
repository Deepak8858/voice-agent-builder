import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Sparkles } from 'lucide-react';

export function ComingSoon({
  title,
  body,
  phase,
}: {
  title: string;
  body: string;
  phase: string;
}) {
  return (
    <div className="flex flex-1 flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      </div>
      <Card className="flex flex-col items-center justify-center gap-4 py-20 text-center border-dashed">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent">
          <Sparkles className="h-7 w-7 text-accent-foreground" />
        </div>
        <div>
          <CardTitle className="text-lg">Coming in {phase}</CardTitle>
          <CardDescription className="max-w-sm mx-auto mt-1">
            This surface is stubbed for Phase 0/1. See docs/20_IMPLEMENTATION_ROADMAP.md for the
            roadmap.
          </CardDescription>
        </div>
      </Card>
    </div>
  );
}
