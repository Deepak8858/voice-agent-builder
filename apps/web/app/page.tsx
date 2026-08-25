import Image from 'next/image';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DemoAudioPlayer } from '@/components/demo-audio-player';
import { JsonLd } from '@/lib/seo';
import { siteUrl } from '@/lib/site-url';
import {
  ArrowRight,
  AudioLines,
  BadgeCheck,
  BarChart3,
  Building2,
  CheckCircle2,
  Clock3,
  Database,
  FileJson2,
  LockKeyhole,
  Mic2,
  Paintbrush,
  PhoneCall,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Workflow,
} from 'lucide-react';

const demoSharePath =
  process.env.NEXT_PUBLIC_DEMO_SHARE_PATH ??
  '/a/ai-receptionist-62c5fb9c-330c-488a-84d9-05d1cc6672aa';

type IconItem = {
  icon: LucideIcon;
  title: string;
  body: string;
};

const heroStats = [
  { value: '5 min', label: 'from plain prompt to a tested call' },
  { value: 'Spec', label: 'Agent JSON before every publish' },
  // Stated as a rule rather than a count: "0 outbound calls" read as "no calls
  // are made at all", which is the opposite of the product claim.
  { value: '100%', label: 'of outbound calls pass compliance gates first' },
  { value: '2', label: 'voice pipelines: in-house Azure and OpenAI Realtime' },
];

const workflowSteps = [
  {
    step: '01',
    icon: Mic2,
    title: 'Describe the caller experience',
    body: 'Capture the business, caller intents, transfer rules, knowledge sources, and systems the agent may touch.',
  },
  {
    step: '02',
    icon: FileJson2,
    title: 'Review the generated contract',
    body: 'VoiceForge produces Agent Spec JSON with goals, tools, compliance policy, analytics, and handoff behavior.',
  },
  {
    step: '03',
    icon: PhoneCall,
    title: 'Test the call before it ships',
    body: 'Run a full call in the browser with live transcript, event stream, and outcome before you point real telephony at it.',
  },
  {
    step: '04',
    icon: BarChart3,
    title: 'Publish, monitor, improve',
    body: 'Ship a demo page, track calls, inspect transcripts, tune versions, and give clients a branded workspace.',
  },
];

const productCapabilities = [
  'Natural-language generation with Zod-validated Agent Spec output',
  'Visual flow editing for questions, transfers, tools, knowledge, and endings',
  'Agent-scoped knowledge sources for business-specific retrieval',
  'Versioning, publish controls, and audit logs around critical actions',
  'Call transcripts, events, outcomes, minutes, and usage analytics',
];

const proofPoints: IconItem[] = [
  {
    icon: FileJson2,
    title: 'Agent Spec JSON',
    body: 'The agent is governed by a reviewable contract, not hidden prompt strings scattered across runtime code.',
  },
  {
    icon: ShieldCheck,
    title: 'Compliance gates',
    body: 'Consent, call windows, opt-outs, DNC/DND, AI disclosure, and recording notice run before outbound execution.',
  },
  {
    icon: Building2,
    title: 'Workspace isolation',
    body: 'Organizations, workspaces, clients, agents, calls, knowledge, and settings stay tenant scoped.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Two voice pipelines, one contract',
    body: 'Our own Azure speech-to-speech pipeline and OpenAI Realtime run behind one runtime interface, so the pipeline your plan uses never changes how the agent is built.',
  },
];

const productionControls: IconItem[] = [
  {
    icon: LockKeyhole,
    title: 'Permissioned tools',
    body: 'Tool calls are validated, authorized, logged, and idempotent where the action allows it.',
  },
  {
    icon: Database,
    title: 'Postgres source of truth',
    body: 'Agent versions, workspaces, calls, compliance records, knowledge, and billing usage stay structured.',
  },
  {
    icon: Paintbrush,
    title: 'White-label delivery',
    body: 'Agencies can ship client dashboards with brand colors, logos, isolated users, and focused analytics.',
  },
];

const transcriptLines = [
  {
    speaker: 'Agent',
    text: 'Thanks for calling Smile Dental. Are you calling to book, reschedule, or ask about an emergency?',
  },
  { speaker: 'Caller', text: 'I need a cleaning next week, preferably morning.' },
  {
    speaker: 'Agent',
    text: 'I can help with that. I found two morning openings and can confirm the best one.',
  },
];

const integrationRows = [
  ['Supabase', 'PostgreSQL', 'Zod schemas'],
  ['Azure AI Speech', 'Azure AI Foundry', 'OpenAI Realtime'],
  ['Twilio', 'LiveKit / BYO telephony', 'In-house voice pipeline'],
  ['Audit logs', 'Compliance checks', 'White-label workspaces'],
];

function Eyebrow({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={`text-xs font-semibold uppercase tracking-[0.22em] ${className}`}>{children}</p>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  dark = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  dark?: boolean;
}) {
  return (
    <div className="min-w-0 max-w-3xl">
      <Eyebrow className={dark ? 'text-[#bfff4a]' : 'text-[#23594f]'}>{eyebrow}</Eyebrow>
      <h2
        className={`mt-4 break-words font-serif text-4xl leading-[1.02] tracking-normal md:text-5xl ${
          dark ? 'text-[#fbf5e7]' : 'text-[#07130f]'
        }`}
      >
        {title}
      </h2>
      <p
        className={`mt-5 break-words text-lg leading-8 ${dark ? 'text-[#cdd8cf]' : 'text-[#51615a]'}`}
      >
        {body}
      </p>
    </div>
  );
}

export default function Home() {
  const softwareApplication = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'VoiceForge AI',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: siteUrl,
    description:
      'A spec-first voice AI operating system for building, testing, governing, and white-labeling client voice-agent deployments.',
    offers: [
      { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Starter', price: '49', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Growth', price: '149', priceCurrency: 'USD' },
      { '@type': 'Offer', name: 'Enterprise', price: '499', priceCurrency: 'USD' },
    ],
  };
  return (
    <div className="flex flex-1 flex-col overflow-x-hidden bg-[#f3efe5] text-[#07130f]">
      <JsonLd data={softwareApplication} />
      <section className="relative isolate overflow-hidden bg-[#06130f] text-[#fbf5e7]">
        <Image
          src="/images/voiceforge-builder-preview.png"
          alt="VoiceForge builder showing the prompt-to-Agent-Spec workflow"
          fill
          priority
          sizes="100vw"
          className="object-cover object-[64%_16%] opacity-35 mix-blend-luminosity"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,#06130f_0%,rgba(6,19,15,0.96)_35%,rgba(6,19,15,0.72)_64%,rgba(6,19,15,0.48)_100%)]" />
        <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(191,255,74,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(114,228,255,0.1)_1px,transparent_1px)] [background-size:72px_72px]" />
        <div className="absolute inset-x-0 bottom-0 h-28 bg-[linear-gradient(180deg,rgba(6,19,15,0),#f3efe5)]" />

        <div className="relative mx-auto flex min-h-[68svh] w-full max-w-7xl flex-col justify-center px-6 py-12 md:px-8 md:py-14">
          <div className="max-w-4xl pt-6">
            <div className="inline-flex items-center gap-2 rounded-md border border-[#bfff4a]/30 bg-[#bfff4a]/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-[#d9ff8a] backdrop-blur">
              <Radio className="h-3.5 w-3.5" />
              Spec-first voice AI operating system
            </div>

            <h1 className="mt-7 max-w-[11ch] font-serif text-6xl leading-[0.9] tracking-normal text-[#fbf5e7] sm:text-7xl md:text-8xl lg:text-[7.5rem]">
              VoiceForge AI
            </h1>

            <p className="mt-6 max-w-3xl text-xl leading-8 text-[#dfe8dd] md:text-2xl md:leading-9">
              Build voice agents from natural language, govern every behavior with Agent Spec JSON,
              test the call before it goes live, and hand clients a branded workspace they can
              trust.
            </p>

            <div className="mt-8 flex w-full max-w-[23rem] flex-col gap-3 sm:max-w-none sm:flex-row">
              <Button
                asChild
                size="lg"
                className="h-12 w-full border border-[#d9ff8a]/70 bg-[#bfff4a] px-6 text-[#07130f] shadow-lg shadow-[#bfff4a]/15 hover:bg-[#d9ff8a] sm:w-auto"
              >
                <Link href="/sign-up">
                  Start building
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 w-full border-white/25 bg-white/10 px-6 text-white backdrop-blur hover:bg-white/15 hover:text-white sm:w-auto"
              >
                <Link href="#demo-call">
                  Hear the demo call
                  <AudioLines className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section className="relative z-10 -mt-6 px-6 pb-14 md:px-8">
        <div className="mx-auto w-full max-w-7xl">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-white/15 bg-[#07130f] shadow-2xl shadow-[#07130f]/18 md:grid-cols-4">
            {heroStats.map((stat) => (
              <div key={stat.label} className="min-w-0 bg-[#0b1d17] p-4 text-[#fbf5e7]">
                <p className="text-2xl font-semibold">{stat.value}</p>
                <p className="mt-1 text-xs leading-5 text-[#c6d3c9]">{stat.label}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 grid gap-3 rounded-md border border-[#cfd8ca] bg-[#fbf6ea] p-3 shadow-xl shadow-[#07130f]/8 md:grid-cols-[0.8fr_1.2fr] md:items-center">
            <div className="flex items-center gap-3 rounded-md bg-[#07130f] px-4 py-3 text-[#fbf5e7]">
              <BadgeCheck className="h-5 w-5 text-[#bfff4a]" />
              <span className="text-sm font-semibold">Built around the first working demo</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm font-medium text-[#394840] sm:grid-cols-5">
              <span>Prompt</span>
              <span>Spec JSON</span>
              <span>Test call</span>
              <span>Analytics</span>
              <span>White label</span>
            </div>
          </div>
        </div>
      </section>

      <section
        id="workflow"
        className="scroll-mt-32 px-6 pb-20 pt-8 md:scroll-mt-24 md:px-8 md:pb-28"
      >
        <div className="mx-auto w-full max-w-7xl">
          <SectionHeading
            eyebrow="From brief to live workflow"
            title="Four steps from brief to a monitored live agent."
            body="VoiceForge is not a prompt wrapper. It is a controlled build, test, publish, and monitor loop for teams that need voice agents to survive real customer calls."
          />

          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {workflowSteps.map((item) => (
              <div
                key={item.step}
                className="group rounded-lg border border-[#d7d0c3] bg-[#fffaf0] p-6 shadow-sm shadow-[#07130f]/5 transition duration-200 hover:-translate-y-1 hover:border-[#23594f]/40 hover:shadow-xl hover:shadow-[#07130f]/10"
              >
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#07130f] text-[#bfff4a] transition group-hover:bg-[#23594f]">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <span className="font-mono text-xs font-medium text-[#23594f]">{item.step}</span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-[#07130f]">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#56635d]">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="product"
        className="scroll-mt-32 bg-[#07130f] px-6 py-20 text-[#fbf5e7] md:scroll-mt-24 md:px-8 md:py-28"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div className="relative min-w-0">
            <div className="absolute -left-4 -top-4 hidden h-28 w-28 border-l border-t border-[#bfff4a]/40 md:block" />
            <div className="overflow-hidden rounded-lg border border-white/15 bg-[#f7f3ea] shadow-2xl shadow-black/30">
              <div className="flex items-center gap-2 border-b border-[#ddd4c5] bg-[#eee7da] px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff6a3d]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#bfff4a]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#72e4ff]" />
                <span className="ml-3 truncate font-mono text-xs text-[#51615a]">
                  app.voiceforge.ai/dashboard/agents/new
                </span>
              </div>
              <Image
                src="/images/voiceforge-builder-preview.png"
                alt="VoiceForge dashboard for creating a new AI voice agent"
                width={1043}
                height={552}
                className="h-auto w-full"
                sizes="(min-width: 1024px) 58vw, 100vw"
              />
            </div>
          </div>

          <div>
            <SectionHeading
              eyebrow="Product surface"
              title="Show the builder, then prove the guardrails."
              body="One system covers the whole lifecycle: prompt generation, versioned specs, test calls, publish controls, transcripts, analytics, and client branding."
              dark
            />
            <ul className="mt-8 space-y-4">
              {productCapabilities.map((capability) => (
                <li key={capability} className="flex gap-3 text-sm leading-6 text-[#d6dfd8]">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#bfff4a]" />
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section
        id="compliance"
        className="scroll-mt-32 bg-[#f3efe5] px-6 py-20 md:scroll-mt-24 md:px-8 md:py-28"
      >
        <div className="mx-auto w-full max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-end">
            <SectionHeading
              eyebrow="Real-world controls"
              title="Built for calls that have legal, brand, and revenue consequences."
              body="Every promise here maps back to an engineering rule: validated specs, scoped data, permissioned tools, adapter boundaries, audit logs, and compliance checks before outbound execution."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {proofPoints.map((point) => (
                <div
                  key={point.title}
                  className="rounded-lg border border-[#d7d0c3] bg-[#fffaf0] p-5"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#07130f] text-[#bfff4a]">
                    <point.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-5 text-base font-semibold text-[#07130f]">{point.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[#56635d]">{point.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {productionControls.map((item) => (
              <div key={item.title} className="rounded-lg border border-[#cad5ca] bg-white p-6">
                <item.icon className="h-6 w-6 text-[#23594f]" />
                <h3 className="mt-4 text-base font-semibold text-[#07130f]">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#56635d]">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        id="demo-call"
        className="scroll-mt-32 bg-[#fbf6ea] px-6 py-20 md:scroll-mt-24 md:px-8 md:py-28"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
          <div className="min-w-0">
            <SectionHeading
              eyebrow="Public demo"
              title="Let prospects hear the product before they read the docs."
              body="Play a real 30-second call from a published agent, then read the transcript and the outcome signals your buyers will ask about."
            />
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                asChild
                size="lg"
                className="h-12 bg-[#07130f] px-6 text-[#fbf5e7] hover:bg-[#23594f]"
              >
                <Link href={demoSharePath}>
                  Open share demo
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 border-[#23594f]/30 bg-white px-6 text-[#07130f] hover:bg-[#e8f2df] hover:text-[#07130f]"
              >
                <Link href="/sign-up">
                  Create your agent
                  <Workflow className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="min-w-0 rounded-lg border border-[#d7d0c3] bg-white p-6 shadow-xl shadow-[#07130f]/8">
            <div className="flex flex-col gap-4 border-b border-[#e1dacd] pb-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-[#07130f]">Smile Dental Receptionist</p>
                <p className="mt-1 text-xs text-[#66736c]">Published demo agent</p>
              </div>
              <div className="inline-flex w-fit items-center gap-2 rounded-md bg-[#e8f2df] px-3 py-1.5 text-xs font-medium text-[#23594f]">
                <Clock3 className="h-3.5 w-3.5" />
                30 sec sample
              </div>
            </div>

            <DemoAudioPlayer
              src="/demo/dental-receptionist-30s.wav"
              label="Dental receptionist - 30 sec call"
              caption="Generated sample call audio"
            />

            <div className="mt-8 space-y-3">
              {transcriptLines.map((line) => (
                <div
                  key={`${line.speaker}-${line.text}`}
                  className="grid gap-2 rounded-md border border-[#e1dacd] bg-[#fbf6ea] p-4 sm:grid-cols-[5rem_1fr]"
                >
                  <span className="font-mono text-xs font-medium uppercase text-[#23594f]">
                    {line.speaker}
                  </span>
                  <p className="text-sm leading-6 text-[#394840]">{line.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section
        id="agencies"
        className="scroll-mt-32 bg-[#07130f] px-6 py-20 text-[#fbf5e7] md:scroll-mt-24 md:px-8 md:py-28"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <SectionHeading
            eyebrow="Agency-ready"
            title="Sell voice agents without rebuilding the operating layer."
            body="VoiceForge gives agencies and internal operators the pieces that usually delay launch: client isolation, branded delivery, usage visibility, provider choice, and compliance-first operations."
            dark
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-white/15 bg-white/[0.06] p-6">
              <Paintbrush className="h-6 w-6 text-[#bfff4a]" />
              <h3 className="mt-5 text-lg font-semibold text-[#fbf5e7]">White-label control</h3>
              <p className="mt-3 text-sm leading-6 text-[#cdd8cf]">
                Configure logos, colors, workspace settings, and client-facing pages without forking
                the product.
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/[0.06] p-6">
              <Building2 className="h-6 w-6 text-[#72e4ff]" />
              <h3 className="mt-5 text-lg font-semibold text-[#fbf5e7]">Client isolation</h3>
              <p className="mt-3 text-sm leading-6 text-[#cdd8cf]">
                Client users only see their workspace, calls, agents, knowledge, analytics, and
                settings.
              </p>
            </div>
            <div className="rounded-lg border border-white/15 bg-white/[0.06] p-6 sm:col-span-2">
              <Eyebrow className="text-[#bfff4a]">Integration path</Eyebrow>
              <div className="mt-5 grid gap-3">
                {integrationRows.map((row) => (
                  <div key={row.join('-')} className="grid gap-2 sm:grid-cols-3">
                    {row.map((integration) => (
                      <span
                        key={integration}
                        className="rounded-md border border-white/15 bg-black/20 px-3 py-2 text-sm font-medium text-[#e5eee7]"
                      >
                        {integration}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#f3efe5] px-6 py-16 md:px-8">
        <div className="mx-auto grid w-full max-w-7xl gap-8 rounded-lg border border-[#cfd8ca] bg-[#fbf6ea] p-6 shadow-xl shadow-[#07130f]/8 md:grid-cols-[1fr_auto] md:items-center md:p-8">
          <div className="max-w-3xl">
            <Eyebrow className="text-[#23594f]">VoiceForge AI</Eyebrow>
            <h2 className="mt-3 font-serif text-4xl leading-tight text-[#07130f] md:text-5xl">
              Build the first agent, test the first call, then ship it to a real workspace.
            </h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 bg-[#07130f] px-6 text-[#fbf5e7] hover:bg-[#23594f]"
            >
              <Link href="/sign-up">
                Get started free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 border-[#23594f]/30 bg-white px-6 text-[#07130f] hover:bg-[#e8f2df] hover:text-[#07130f]"
            >
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-[#d7d0c3] bg-[#fbf6ea] px-6 py-10 md:px-8">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-serif text-xl text-[#07130f]">VoiceForge AI</p>
            <p className="mt-1 text-sm text-[#66736c]">
              Spec-first voice agents for SaaS teams and agencies.
            </p>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm text-[#51615a]">
            <Link href="/#product" className="transition hover:text-[#23594f]">
              Product
            </Link>
            <Link href="/how-it-works" className="transition hover:text-[#23594f]">
              Workflow
            </Link>
            <Link href="/compliance" className="transition hover:text-[#23594f]">
              Compliance
            </Link>
            <Link href="/templates" className="transition hover:text-[#23594f]">
              Templates
            </Link>
            <Link href="/for-agencies" className="transition hover:text-[#23594f]">
              Agencies
            </Link>
            <Link href="/integrations" className="transition hover:text-[#23594f]">
              Integrations
            </Link>
            <Link href="/resources" className="transition hover:text-[#23594f]">
              Resources
            </Link>
            <Link href="/pricing" className="transition hover:text-[#23594f]">
              Pricing
            </Link>
            <Link href={demoSharePath} className="transition hover:text-[#23594f]">
              Share demo
            </Link>
            <Link href="/sign-up" className="transition hover:text-[#23594f]">
              Sign up
            </Link>
            <Link href="/sign-in" className="transition hover:text-[#23594f]">
              Sign in
            </Link>
            <Link href="/services" className="transition hover:text-[#23594f]">
              Services
            </Link>
            <Link href="/support" className="transition hover:text-[#23594f]">
              Support
            </Link>
            <Link href="/refund" className="transition hover:text-[#23594f]">
              Refunds
            </Link>
            <Link href="/privacypolicy" className="transition hover:text-[#23594f]">
              Privacy
            </Link>
          </nav>
          <p className="text-sm text-[#66736c]">&copy; 2026 VoiceForge AI</p>
        </div>
      </footer>
    </div>
  );
}
