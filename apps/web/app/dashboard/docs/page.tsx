import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/dashboard/page-header';
import {
  agentSpecReference,
  checklistSections,
  dashboardDocumentation,
  firstWorkingDemoSteps,
  userDocsConcepts,
  userDocsTroubleshooting,
} from '@/lib/user-docs-content';
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileCode,
  LifeBuoy,
  Route,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

const jumpLinks = [
  { href: '#quick-start', label: 'Quick start' },
  { href: '#concepts', label: 'Core concepts' },
  { href: '#dashboard-guide', label: 'Dashboard guide' },
  { href: '#agent-spec', label: 'Agent Spec' },
  { href: '#checklists', label: 'Checklists' },
  { href: '#troubleshooting', label: 'Troubleshooting' },
];

export default function UserDocsPage() {
  const dashboardAreaCount = dashboardDocumentation.reduce(
    (sum, group) => sum + group.items.length,
    0,
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="User docs"
        title="Build, test, deploy, and manage AI voice agents."
        description="A detailed operating guide for VoiceForge users. Follow the first demo path, then use the feature reference when you need to configure agents, calls, compliance, integrations, analytics, white-label branding, or billing."
        actions={
          <>
            <Button asChild variant="outline" className="gap-2">
              <Link href="/dashboard/compliance">
                <ShieldCheck className="h-4 w-4" />
                Compliance
              </Link>
            </Button>
            <Button asChild className="gap-2">
              <Link href="/dashboard/agents/new">
                <Sparkles className="h-4 w-4" />
                Create agent
              </Link>
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <HeaderMetric label="Demo steps" value={firstWorkingDemoSteps.length.toString()} />
          <HeaderMetric label="Dashboard areas" value={dashboardAreaCount.toString()} />
          <HeaderMetric label="Spec sections" value={agentSpecReference.length.toString()} />
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden xl:block">
          <nav className="sticky top-8 rounded-2xl border border-border/80 bg-card/85 p-3 shadow-sm" aria-label="Documentation sections">
            <p className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">
              On this page
            </p>
            <div className="flex flex-col gap-1">
              {jumpLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </nav>
        </aside>

        <main className="flex min-w-0 flex-col gap-10">
          <section id="quick-start" className="scroll-mt-24">
            <SectionHeading
              icon={<Route className="h-4 w-4" />}
              title="First Working Demo"
              description="The shortest path through the product from signup to a branded workspace."
            />
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {firstWorkingDemoSteps.map((step) => (
                <Card key={step.title} className="flex flex-col bg-card/95">
                  <CardHeader className="pb-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <Badge variant="secondary">{step.title.split('.')[0]}</Badge>
                      <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5 px-2">
                        <Link href={step.href}>
                          Open
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    </div>
                    <CardTitle className="text-base">{step.title.replace(/^\d+\.\s*/, '')}</CardTitle>
                    <CardDescription className="leading-6">{step.summary}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-4">
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {step.details.map((detail) => (
                        <li key={detail} className="flex gap-2">
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <span>{detail}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-auto rounded-xl border border-border bg-muted/35 px-3 py-2 text-xs leading-5 text-muted-foreground">
                      <span className="font-semibold text-foreground">Result:</span> {step.result}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section id="concepts" className="scroll-mt-24">
            <SectionHeading
              icon={<BookOpen className="h-4 w-4" />}
              title="Core Concepts"
              description="The ideas that explain why the app behaves the way it does."
            />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              {userDocsConcepts.map((concept) => (
                <Card key={concept.title} className="bg-card/95">
                  <CardHeader>
                    <CardTitle className="text-base">{concept.title}</CardTitle>
                    <CardDescription className="leading-6">{concept.body}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {concept.bullets.map((bullet) => (
                        <li key={bullet} className="flex gap-2">
                          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{bullet}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section id="dashboard-guide" className="scroll-mt-24">
            <SectionHeading
              icon={<ClipboardList className="h-4 w-4" />}
              title="Dashboard Guide"
              description="What each navigation area is for and what to do there."
            />
            <div className="mt-4 flex flex-col gap-6">
              {dashboardDocumentation.map((group) => (
                <div key={group.title} className="rounded-2xl border border-border/80 bg-card/70 p-4">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-foreground">{group.title}</h3>
                      <p className="text-sm leading-6 text-muted-foreground">{group.description}</p>
                    </div>
                    <Badge variant="outline">{group.items.length} areas</Badge>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {group.items.map((item) => (
                      <Card key={item.href} className="bg-background/70 shadow-none">
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <CardTitle className="text-base">{item.title}</CardTitle>
                              <CardDescription className="mt-1 leading-6">{item.purpose}</CardDescription>
                            </div>
                            <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
                              <Link href={item.href}>
                                Open
                                <ArrowRight className="h-3.5 w-3.5" />
                              </Link>
                            </Button>
                          </div>
                        </CardHeader>
                        <CardContent className="grid gap-4 sm:grid-cols-2">
                          <MiniList title="Use it to" items={item.primaryActions} />
                          <MiniList title="Remember" items={item.notes} />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section id="agent-spec" className="scroll-mt-24">
            <SectionHeading
              icon={<FileCode className="h-4 w-4" />}
              title="Agent Spec JSON"
              description="The validated contract behind every generated and edited voice agent."
            />
            <Card className="mt-4 bg-card/95">
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-xs uppercase tracking-[0.16em] text-muted-foreground">
                        <th className="px-4 py-3 font-semibold">Section</th>
                        <th className="px-4 py-3 font-semibold">Purpose</th>
                        <th className="px-4 py-3 font-semibold">User impact</th>
                        <th className="px-4 py-3 font-semibold">Validation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentSpecReference.map((section) => (
                        <tr key={section.key} className="border-b border-border/70 last:border-0">
                          <td className="px-4 py-4 align-top">
                            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
                              {section.key}
                            </code>
                            <p className="mt-2 font-medium text-foreground">{section.label}</p>
                          </td>
                          <td className="max-w-sm px-4 py-4 align-top leading-6 text-muted-foreground">
                            {section.purpose}
                          </td>
                          <td className="max-w-sm px-4 py-4 align-top leading-6 text-muted-foreground">
                            {section.userImpact}
                          </td>
                          <td className="max-w-sm px-4 py-4 align-top leading-6 text-muted-foreground">
                            {section.validation}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </section>

          <section id="checklists" className="scroll-mt-24">
            <SectionHeading
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Operational Checklists"
              description="Use these before changes reach customers or clients."
            />
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {checklistSections.map((section) => (
                <Card key={section.title} className="bg-card/95">
                  <CardHeader>
                    <CardTitle className="text-base">{section.title}</CardTitle>
                    <CardDescription className="leading-6">{section.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {section.items.map((item) => (
                        <li key={item} className="flex gap-2">
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section id="troubleshooting" className="scroll-mt-24">
            <SectionHeading
              icon={<LifeBuoy className="h-4 w-4" />}
              title="Troubleshooting"
              description="Common issues and the first place to look."
            />
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              {userDocsTroubleshooting.map((item) => (
                <Card key={item.problem} className="bg-card/95">
                  <CardHeader>
                    <CardTitle className="text-base">{item.problem}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">{item.fix}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-background/70 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-[family-name:var(--font-serif)] text-3xl leading-none text-foreground">
        {value}
      </p>
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-card text-primary">
          {icon}
        </span>
        <h2 className="font-[family-name:var(--font-serif)] text-2xl leading-tight text-foreground sm:text-3xl">
          {title}
        </h2>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
    </div>
  );
}

function MiniList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </p>
      <ul className="space-y-2 text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item} className="flex gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/80" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
