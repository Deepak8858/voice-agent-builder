import { Card, CardTitle } from '@/components/ui/primitives';

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
    <div className="flex flex-1 flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {title}
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{body}</p>
      </header>
      <Card className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <CardTitle>Coming in {phase}</CardTitle>
        <p className="max-w-md text-sm text-zinc-500">
          This surface is stubbed for Phase 0/1. See docs/20_IMPLEMENTATION_ROADMAP.md for the
          roadmap.
        </p>
      </Card>
    </div>
  );
}
