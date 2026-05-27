import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { EmptyState, PageHeader, StatusBadge } from '@/components/dashboard';
import { ArrowRight } from 'lucide-react';

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  industry: string;
  agent_type: string;
}

export default async function TemplatesPage() {
  let items: TemplateSummary[] = [];
  let apiError: string | null = null;

  try {
    const res = await apiFetch<{ items: TemplateSummary[] }>('/templates');
    items = res.items;
  } catch (err) {
    apiError = (err as Error).message;
  }

  if (apiError) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader
          eyebrow="Template library"
          title="Templates"
          description={
            <>
              Could not load templates:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">{apiError}</code>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Template library"
        title="Templates"
        description="Vertical starting points for common voice-agent use cases. Pick one to pre-fill an Agent Spec, then customize it for your workflow."
      />

      {items.length === 0 ? (
        <EmptyState
          title="No templates available"
          description="Templates will appear here once they are configured for this workspace."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((t) => (
            <Card key={t.slug} className="flex flex-col overflow-hidden bg-card/95 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              <CardHeader className="border-b border-border/70 bg-muted/25 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="text-base">{t.name}</CardTitle>
                  <StatusBadge status={t.agent_type.replace('_', ' ')} className="shrink-0" />
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4 p-5">
                <CardDescription className="leading-relaxed">{t.description}</CardDescription>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  {t.industry}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-3">
                  <Button asChild size="sm" className="gap-2">
                    <Link href={`/dashboard/agents/new?template=${t.slug}`}>
                      Use template
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
                    {t.slug}
                  </code>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
