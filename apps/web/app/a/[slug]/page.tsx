import { notFound } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { Mic2, Building2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DemoAudioPlayer } from '@/components/demo-audio-player';
import { sharePageMetadata } from './share-metadata';

interface AgentSharePageProps {
  params: Promise<{ slug: string }>;
}

const PublicAgentShareSchema = z.discriminatedUnion('found', [
  z.object({
    found: z.literal(true),
    id: z.string().uuid(),
    name: z.string(),
    shareSlug: z.string().min(1).optional(),
    publicPath: z.string().min(1).optional(),
    demoAudioUrl: z.string().min(1).nullable().optional(),
    sampleTranscript: z
      .array(z.object({ speaker: z.string(), text: z.string() }))
      .default([]),
    spec: z
      .object({
        identity: z
          .object({
            business_name: z.string().optional(),
            agent_name: z.string().optional(),
          })
          .catchall(z.unknown())
          .default({}),
        voice: z.record(z.unknown()).default({}),
        goals: z.array(z.string()).default([]),
      })
      .default({ identity: {}, voice: {}, goals: [] }),
    workspaceName: z.string(),
    organizationName: z.string().nullable().optional(),
    branding: z
      .object({
        brandName: z.string().nullable(),
        logoUrl: z.string().nullable(),
        primaryColor: z.string().nullable(),
        hidePlatformBranding: z.boolean(),
      })
      .nullable()
      .optional(),
    publishedAt: z.string().or(z.date()).optional(),
  }),
  z.object({ found: z.literal(false) }),
]);

const ApiEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown().nullable(),
  error: z.unknown().nullable().optional(),
});

async function getAgentBySlug(slug: string) {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
  try {
    const res = await fetch(`${baseUrl}/agents/a/${slug}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const envelope = ApiEnvelopeSchema.safeParse(json);
    const payload = envelope.success ? envelope.data.data : json;
    const parsed = PublicAgentShareSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export default async function AgentSharePage({ params }: AgentSharePageProps) {
  const { slug } = await params;
  const agent = await getAgentBySlug(slug);

  if (!agent || !agent.found) {
    notFound();
  }

  const ref = agent.shareSlug ?? slug;
  const brandName = agent.branding?.brandName ?? agent.workspaceName;

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20 flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
              <Mic2 className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-serif text-lg">{brandName}</span>
          </Link>
          <Link href={`/sign-up?ref=${ref}`}>
            <Button size="sm" className="gap-2">
              Build your own
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-2xl">
          {/* Agent card */}
          <div className="rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
            {/* Agent header */}
            <div className="p-8 pb-0">
              <div className="flex items-center gap-4 mb-6">
                <div className="h-16 w-16 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Mic2 className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-semibold">{agent.name}</h1>
                  <p className="text-muted-foreground flex items-center gap-1.5 mt-0.5">
                    {agent.organizationName && (
                      <>
                        <Building2 className="h-3.5 w-3.5" />
                        {agent.organizationName}
                      </>
                    )}
                    {!agent.organizationName && (
                      <span>{agent.workspaceName}</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Demo audio player */}
              <div className="mb-6">
                <DemoAudioPlayer
                  src={agent.demoAudioUrl ?? undefined}
                  label="Sample call demo"
                  caption="Generated sample call audio"
                />
              </div>
            </div>

            {/* Sample transcript */}
            <div className="px-8 pb-8">
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                  Sample Conversation
                </p>
                <div className="space-y-3 text-sm">
                  {agent.sampleTranscript?.map((turn: { speaker: string; text: string }, i: number) => (
                    <div
                      key={i}
                      className={turn.speaker === 'agent' ? 'text-foreground' : 'text-muted-foreground'}
                    >
                      <span className="font-medium text-xs">
                        {turn.speaker === 'agent' ? 'Agent' : 'Caller'}:
                      </span>
                      <span className="ml-2">{turn.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Agent details */}
              {agent.spec && (
                <div className="mt-6 grid grid-cols-2 gap-4">
                  {agent.spec.identity?.business_name && (
                    <div className="rounded-lg bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Business</p>
                      <p className="text-sm font-medium">{agent.spec.identity.business_name}</p>
                    </div>
                  )}
                  {agent.spec.goals?.length > 0 && (
                    <div className="rounded-lg bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Capabilities</p>
                      <p className="text-sm font-medium">{agent.spec.goals.length} tasks</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* CTA */}
            <div className="border-t border-border bg-muted/30 p-8 text-center">
              <p className="text-muted-foreground mb-4">
                Build your own voice agent in minutes
              </p>
              <Link href={`/sign-up?ref=${ref}`}>
                <Button size="lg" className="gap-2">
                  Build your own voice agent
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <p className="mt-3 text-xs text-muted-foreground">
                Free to start · No credit card required
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto max-w-4xl flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Mic2 className="h-3.5 w-3.5" />
            <span>{brandName}</span>
          </div>
          <Link href="/pricing" className="hover:text-foreground transition-colors">
            View pricing
          </Link>
        </div>
      </footer>
    </div>
  );
}

export async function generateMetadata({ params }: AgentSharePageProps) {
  const { slug } = await params;
  const agent = await getAgentBySlug(slug);

  if (!agent || !agent.found) {
    return sharePageMetadata(slug, null);
  }

  return sharePageMetadata(slug, {
    name: agent.name,
    workspaceName: agent.workspaceName,
    businessName: agent.spec?.identity?.business_name,
  });
}
