import Link from 'next/link';
import { Show, SignInButton, SignUpButton } from '@clerk/nextjs';
import { Button } from '@/components/ui/button';
import {
  Mic2,
  Shield,
  Paintbrush,
  ArrowRight,
  Radio,
  Waves,
  GitBranch,
  PhoneCall,
} from 'lucide-react';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-border bg-gradient-to-br from-background via-background to-accent/30 px-6 py-24 md:py-32">
        <div className="absolute inset-0 grain opacity-50" />
        <div className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-chart-3/5 blur-3xl" />

        <div className="relative mx-auto max-w-5xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-sm mb-8">
            <Radio className="h-3.5 w-3.5 text-primary" />
            Now with real-time call testing
          </div>

          <h1
            className="font-[family-name:var(--font-serif)] text-5xl font-normal leading-[1.1] tracking-tight text-foreground sm:text-6xl md:text-7xl"
            style={{ animationDelay: '0.1s' }}
          >
            Build voice agents
            <br />
            <span className="text-primary">that answer back.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            Describe what your agent should do. VoiceForge generates the voice persona,
            call flow, knowledge base, tools, compliance settings, and a white-label
            dashboard for your clients.
          </p>

          <div className="mt-10 flex items-center justify-center gap-4">
            <Show when="signed-out">
              <SignUpButton mode="modal">
                <Button size="lg" className="gap-2 px-8 shadow-lg shadow-primary/20">
                  Get started free
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </SignUpButton>
              <SignInButton mode="modal">
                <Button variant="outline" size="lg">
                  Sign in
                </Button>
              </SignInButton>
            </Show>
            <Show when="signed-in">
              <Link href="/dashboard">
                <Button size="lg" className="gap-2 px-8 shadow-lg shadow-primary/20">
                  Open dashboard
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </Show>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="px-6 py-20 md:py-28">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl text-foreground md:text-4xl">
              Everything you need to ship voice AI
            </h2>
            <p className="mt-3 text-muted-foreground">
              From prompt to production in minutes, not months.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Mic2,
                title: 'Prompt to agent',
                body: 'Describe your agent in plain English. We generate the full Agent Spec JSON — voice, flow, tools, and compliance.',
              },
              {
                icon: GitBranch,
                title: 'Visual flow builder',
                body: 'Design call flows with a node-based canvas. Conditions, transfers, tool calls, and handoffs — all visual.',
              },
              {
                icon: Shield,
                title: 'Compliance-first',
                body: 'Consent, DNC/DND, opt-out, call windows, and AI disclosure enforced by default on every outbound call.',
              },
              {
                icon: Paintbrush,
                title: 'White-label ready',
                body: 'Spin up agency + client workspaces, brand the dashboard, customize domains, and sell voice agents.',
              },
            ].map((feature, i) => (
              <div
                key={feature.title}
                className="group relative rounded-xl border border-border bg-card p-6 shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5"
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <feature.icon className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border bg-muted/30 px-6 py-20 md:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="mb-14 text-center">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl text-foreground md:text-4xl">
              Three steps to your first call
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Describe your agent',
                desc: 'Write a few sentences about what your agent does, who it speaks to, and what tools it needs.',
                icon: Waves,
              },
              {
                step: '02',
                title: 'Review the spec',
                desc: 'VoiceForge generates a complete Agent Spec JSON. Edit personas, prompts, and flows in the visual builder.',
                icon: GitBranch,
              },
              {
                step: '03',
                title: 'Test and deploy',
                desc: 'Run a browser test call, review transcripts, adjust. Hit publish and your agent starts answering.',
                icon: PhoneCall,
              },
            ].map((item, i) => (
              <div key={item.step} className="relative flex flex-col items-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20 mb-5">
                  <item.icon className="h-7 w-7" />
                </div>
                <span className="text-xs font-bold uppercase tracking-widest text-primary/70 mb-2">
                  Step {item.step}
                </span>
                <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-sm">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-20 md:py-28">
        <div className="relative mx-auto max-w-4xl overflow-hidden rounded-2xl bg-gradient-to-br from-primary to-chart-2 px-6 py-16 text-center shadow-xl">
          <div className="absolute inset-0 grain opacity-30" />
          <div className="relative">
            <h2 className="font-[family-name:var(--font-serif)] text-3xl text-white md:text-4xl">
              Ready to build your first voice agent?
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-primary-foreground/90">
              Start free. No credit card required. Get a working agent in under five minutes.
            </p>
            <div className="mt-8 flex justify-center gap-4">
              <Show when="signed-out">
                <SignUpButton mode="modal">
                  <Button
                    size="lg"
                    variant="secondary"
                    className="gap-2 px-8 text-primary shadow-lg"
                  >
                    Get started free
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <Link href="/dashboard">
                  <Button
                    size="lg"
                    variant="secondary"
                    className="gap-2 px-8 text-primary shadow-lg"
                  >
                    Open dashboard
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </Link>
              </Show>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-background px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 md:flex-row">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-primary flex items-center justify-center">
              <Waves className="h-3.5 w-3.5 text-primary-foreground" />
            </div>
            <span className="font-[family-name:var(--font-serif)] text-sm font-medium">
              VoiceForge AI
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} VoiceForge AI. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
