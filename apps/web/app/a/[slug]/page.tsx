import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Mic2, Building2, ArrowRight, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AgentSharePageProps {
  params: Promise<{ slug: string }>;
}

async function getAgentBySlug(slug: string) {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
  try {
    const res = await fetch(`${baseUrl}/agents/a/${slug}`, {
      next: { revalidate: 60 }, // Cache for 60 seconds
    });
    if (!res.ok) return null;
    return res.json();
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

  const ref = slug; // Used as referral

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-accent/20 flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-background/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-6 py-4 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
              <Mic2 className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="font-serif text-lg">VoiceForge</span>
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
              {agent.demoAudioUrl ? (
                <div className="rounded-xl border border-border/50 bg-muted/30 p-4 mb-6">
                  <div className="flex items-center gap-4">
                    <button className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors">
                      <Play className="h-5 w-5 ml-0.5" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Sample call demo</p>
                      <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary w-0" />
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground font-mono">0:00 / 0:30</span>
                  </div>
                  <audio className="hidden" src={agent.demoAudioUrl} controls />
                </div>
              ) : (
                <div className="rounded-xl border border-border/50 bg-muted/30 p-4 mb-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    Live demo coming soon
                  </p>
                </div>
              )}
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
                        {turn.speaker === 'agent' ? '🤖 Agent' : '👤 Caller'}:
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
            <span>VoiceForge AI</span>
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
    return { title: 'Agent Not Found' };
  }

  return {
    title: `${agent.name} — Voice Agent by ${agent.workspaceName}`,
    description: `Try this AI voice agent for ${agent.spec?.identity?.business_name ?? 'your business'}. Built with VoiceForge AI.`,
  };
}