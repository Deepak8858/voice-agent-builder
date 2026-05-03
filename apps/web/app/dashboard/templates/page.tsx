import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
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
        <div>
          <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Could not load templates: <code className="text-xs bg-muted px-1 py-0.5 rounded">{apiError}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="font-[family-name:var(--font-serif)] text-3xl text-foreground">Templates</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Vertical starting points. Pick one from the new-agent page to pre-fill the Agent
          Spec, or browse the JSON here.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((t) => (
          <Card key={t.slug} className="flex flex-col">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base">{t.name}</CardTitle>
                <Badge variant="outline" className="shrink-0 capitalize">
                  {t.agent_type.replace('_', ' ')}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col flex-1 gap-4">
              <CardDescription className="leading-relaxed">{t.description}</CardDescription>
              <p className="text-xs text-muted-foreground">Industry: {t.industry}</p>
              <div className="mt-auto flex items-center gap-3">
                <Link href={`/dashboard/agents/new?template=${t.slug}`}>
                  <Button size="sm" className="gap-2">
                    Use template
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
                <code className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground font-mono">
                  {t.slug}
                </code>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
