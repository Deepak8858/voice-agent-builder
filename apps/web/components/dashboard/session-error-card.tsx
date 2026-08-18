import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Rendered inside a streamed section when its data fetch failed.
 *
 * Pages used to swap their whole body — header included — for an error
 * variant. Now the shell stays put and only the failed section degrades, so a
 * transient API error no longer blanks the page.
 */
export function SessionErrorCard({
  title,
  message,
}: {
  title: string;
  message: string | null;
}) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle className="text-destructive">{title}</CardTitle>
        <CardDescription>
          The backend returned:{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            {message ?? 'Unknown error'}
          </code>
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
