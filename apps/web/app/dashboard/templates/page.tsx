import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { Badge, Card, CardTitle } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';

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
      <div className="flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Templates
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Could not load templates: <code className="text-xs">{apiError}</code>
          </p>
        </header>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Templates
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Vertical starting points. Pick one from the new-agent page to pre-fill the Agent
          Spec, or browse the JSON here.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((t) => (
          <Card key={t.slug} className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <CardTitle>{t.name}</CardTitle>
              <Badge>{t.agent_type.replace('_', ' ')}</Badge>
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">{t.description}</p>
            <p className="text-xs text-zinc-500">Industry: {t.industry}</p>
            <div className="mt-auto flex items-center gap-2">
              <Link href={`/dashboard/agents/new?template=${t.slug}`}>
                <Button>Use template</Button>
              </Link>
              <code className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                {t.slug}
              </code>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
