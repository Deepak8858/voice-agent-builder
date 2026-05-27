import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { DemoAudioPlayer } from '@/components/demo-audio-player';
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
  GitBranch,
  Headphones,
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

const heroStats = [
  { value: '5 min', label: 'from prompt to test call' },
  { value: 'JSON', label: 'spec-first agent contract' },
  { value: '100%', label: 'workspace-scoped records' },
  { value: 'Mock + real', label: 'provider adapter path' },
];

const proofPoints = [
  {
    icon: FileJson2,
    title: 'Agent Spec JSON',
    body: 'Voice, goals, tools, knowledge, handoff rules, analytics, and compliance are generated into one reviewable contract.',
  },
  {
    icon: ShieldCheck,
    title: 'Compliance gates',
    body: 'Outbound checks cover consent, call windows, opt-outs, DNC/DND, AI disclosure, and recording notice before a call runs.',
  },
  {
    icon: Building2,
    title: 'Tenant-safe SaaS',
    body: 'Organizations, workspaces, agency clients, roles, calls, knowledge, and settings stay scoped to the customer workspace.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Provider adapters',
    body: 'Mock runtime first, with the same deployment surface ready for Vapi, Retell, and future voice providers.',
  },
];

const workflowSteps = [
  {
    step: '01',
    icon: Mic2,
    title: 'Describe the business',
    body: 'Start with plain language: industry, caller needs, handoff rules, booking flow, and systems the agent should use.',
  },
  {
    step: '02',
    icon: GitBranch,
    title: 'Review the generated spec',
    body: 'Inspect the Agent Spec JSON and visual flow before publishing so prompts, tools, and policies are never hidden magic.',
  },
  {
    step: '03',
    icon: PhoneCall,
    title: 'Run a test call',
    body: 'Use the mock voice runtime to capture a transcript, outcome, and events before connecting real telephony.',
  },
  {
    step: '04',
    icon: BarChart3,
    title: 'Publish and monitor',
    body: 'Share the public demo page, watch calls, analyze outcomes, and manage client branding from one workspace.',
  },
];

const productCapabilities = [
  'Prompt-to-agent generation with Zod-validated schema output',
  'Visual flow editing for questions, transfers, tools, and endings',
  'Knowledge sources and agent-scoped retrieval for business context',
  'Audit logs around critical actions and publish operations',
  'Call transcripts, events, outcomes, minutes, and cost estimates',
];

const productionControls = [
  {
    icon: LockKeyhole,
    title: 'Permissioned tools',
    body: 'Tool calls are validated, scoped, logged, and designed to be idempotent where the action allows it.',
  },
  {
    icon: Database,
    title: 'Postgres source of truth',
    body: 'Agent versions, workspaces, calls, knowledge, compliance records, and billing usage stay in structured data.',
  },
  {
    icon: Paintbrush,
    title: 'White-label delivery',
    body: 'Agency teams can create client workspaces, configure branding, and hand off a focused client dashboard.',
  },
];

const integrations = ['Supabase', 'PostgreSQL', 'Vapi', 'Retell', 'Twilio-ready', 'OpenAI-ready'];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col overflow-x-hidden bg-[#fff8f1] text-[#1f130b]">
      <section className="relative isolate overflow-hidden bg-[#241105] text-white">
        <Image
          src="/images/voiceforge-builder-preview.png"
          alt="VoiceForge builder showing prompt-to-Agent-Spec workflow"
          fill
          priority
          sizes="100vw"
          className="object-cover object-right-top opacity-20 md:opacity-[0.34]"
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(249,115,22,0.28),transparent_30%),linear-gradient(90deg,#241105_0%,rgba(36,17,5,0.96)_40%,rgba(67,28,7,0.78)_74%,rgba(154,52,18,0.28)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-[linear-gradient(180deg,rgba(36,17,5,0),#241105)]" />

        <div className="relative mx-auto flex min-h-[720px] w-full max-w-7xl flex-col justify-center px-6 py-20 md:min-h-[760px] md:px-8">
          <div className="w-full max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-md border border-orange-300/30 bg-orange-500/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-orange-100 backdrop-blur">
              <Radio className="h-3.5 w-3.5" />
              Production-first voice AI SaaS
            </div>

            <h1 className="mt-8 max-w-[11ch] break-words text-4xl font-semibold leading-[1.04] tracking-normal text-white sm:max-w-4xl sm:text-6xl lg:text-7xl">
              AI voice agents for real customer calls
            </h1>

            <p className="mt-6 max-w-[29ch] text-lg leading-8 text-slate-200 sm:max-w-2xl md:text-xl">
              VoiceForge AI turns a natural-language brief into a workspace-scoped voice
              agent with a validated spec, mock call testing, compliance checks,
              transcripts, analytics, and white-label client delivery.
            </p>

            <div className="mt-9 flex w-full max-w-[22rem] flex-col gap-3 sm:max-w-none sm:flex-row">
              <Button
                asChild
                size="lg"
                className="h-12 w-full bg-orange-400 px-6 text-[#211005] shadow-lg shadow-orange-950/35 hover:bg-orange-300 sm:w-auto"
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
                className="h-12 w-full border-orange-200/35 bg-white/10 px-6 text-white hover:bg-orange-300/15 hover:text-white sm:w-auto"
              >
                <Link href="#demo-call">
                  Listen to sample call
                  <AudioLines className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="mt-16 grid w-full max-w-5xl grid-cols-1 gap-px overflow-hidden rounded-lg border border-orange-200/20 bg-orange-200/15 sm:grid-cols-2 md:grid-cols-4">
            {heroStats.map((stat) => (
              <div key={stat.label} className="min-w-0 bg-[#241105]/76 p-4 backdrop-blur">
                <p className="text-xl font-semibold text-white">{stat.value}</p>
                <p className="mt-1 break-words text-xs leading-5 text-slate-300">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b border-orange-200 bg-white px-6 py-4 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2 font-medium text-slate-900">
            <BadgeCheck className="h-4 w-4 text-orange-700" />
            Built around the MVP flow in the product docs
          </div>
          <div className="grid w-full min-w-0 grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:flex-wrap sm:gap-x-5">
            <span className="min-w-0">Prompt to spec</span>
            <span className="min-w-0">Test call</span>
            <span className="min-w-0">Publish share page</span>
            <span className="min-w-0">Analytics</span>
            <span className="min-w-0">White label</span>
          </div>
        </div>
      </section>

      <section id="workflow" className="px-6 py-20 md:px-8 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
              From promise to product
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 md:text-5xl">
              A landing page that matches the actual production flow.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              The page now sells what the app can demonstrate: generate an agent,
              review the contract, test a call, publish a public share page, and
              monitor the result without bypassing tenant or compliance rules.
            </p>
          </div>

          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {workflowSteps.map((item) => (
              <div
                key={item.step}
                className="rounded-lg border border-orange-200 bg-white p-6 shadow-sm shadow-orange-950/5 transition duration-200 hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#241105] text-orange-100">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <span className="font-mono text-xs font-medium text-orange-500">
                    {item.step}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-slate-950">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="product" className="border-y border-orange-200 bg-[#fff2df] px-6 py-20 md:px-8 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
          <div className="overflow-hidden rounded-lg border border-orange-200 bg-white shadow-xl shadow-orange-950/10">
            <div className="flex items-center gap-2 border-b border-orange-100 bg-orange-50 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-stone-400" />
              <span className="ml-3 truncate font-mono text-xs text-stone-600">
                app.voiceforge.ai/dashboard/agents/new
              </span>
            </div>
            <Image
              src="/images/voiceforge-builder-preview.png"
              alt="VoiceForge dashboard for creating a new AI voice agent"
              width={1043}
              height={552}
              className="h-auto w-full"
              sizes="(min-width: 1024px) 56vw, 100vw"
            />
          </div>

          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
              Product surface
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 md:text-5xl">
              Show the builder, not a fantasy dashboard.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Prospects see the same system they will use: a workspace app for
              building, versioning, testing, publishing, and operating voice agents.
            </p>
            <ul className="mt-8 space-y-4">
              {productCapabilities.map((capability) => (
                <li key={capability} className="flex gap-3 text-sm leading-6 text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-orange-700" />
                  <span>{capability}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="compliance" className="bg-white px-6 py-20 md:px-8 md:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
                Real-world controls
              </p>
              <h2 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 md:text-5xl">
                Built for teams that cannot ship unsafe calls.
              </h2>
            </div>
            <p className="text-lg leading-8 text-slate-600">
              VoiceForge positions the landing page around the engineering rules in
              the repo: scoped data, validated specs, permissioned tools, adapters,
              auditability, and compliance checks before outbound execution.
            </p>
          </div>

          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {proofPoints.map((point) => (
              <div key={point.title} className="rounded-lg border border-orange-200 bg-orange-50/60 p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-white text-orange-700 shadow-sm">
                  <point.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-5 text-base font-semibold text-slate-950">{point.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{point.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {productionControls.map((item) => (
              <div key={item.title} className="rounded-lg border border-orange-200 bg-white p-6">
                <item.icon className="h-6 w-6 text-orange-700" />
                <h3 className="mt-4 text-base font-semibold text-slate-950">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="demo-call" className="border-y border-orange-950 bg-[#241105] px-6 py-20 text-white md:px-8 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
              Public demo
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal md:text-5xl">
              A real sample call path, with a share page fallback.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-300">
              The landing page now points at the same WAV asset used by published
              public agents. If a share page cannot load audio, the demo player falls
              back gracefully instead of showing a broken promise.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                asChild
                size="lg"
                className="h-12 bg-orange-400 px-6 text-[#211005] hover:bg-orange-300"
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
                className="h-12 border-orange-200/30 bg-white/10 px-6 text-white hover:bg-orange-300/15 hover:text-white"
              >
                <Link href="/sign-up">
                  Create your agent
                  <Workflow className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-orange-200/15 bg-white/[0.06] p-6 shadow-2xl shadow-black/30">
            <div className="flex items-center justify-between gap-4 border-b border-orange-200/15 pb-4">
              <div>
                <p className="text-sm font-semibold text-white">Smile Dental Receptionist</p>
                <p className="mt-1 text-xs text-slate-400">Published demo agent</p>
              </div>
              <div className="flex items-center gap-2 rounded-md bg-orange-400/15 px-3 py-1.5 text-xs font-medium text-orange-100">
                <Clock3 className="h-3.5 w-3.5" />
                30 sec
              </div>
            </div>

            <DemoAudioPlayer
              src="/demo/dental-receptionist-30s.wav"
              label="Dental receptionist - 30 sec call"
              caption="Generated sample call audio"
            />

            <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
              <div className="rounded-md border border-orange-200/15 bg-black/20 p-4">
                <Headphones className="h-5 w-5 text-orange-200" />
                <p className="mt-3 font-medium text-white">Natural greeting</p>
              </div>
              <div className="rounded-md border border-orange-200/15 bg-black/20 p-4">
                <FileJson2 className="h-5 w-5 text-orange-200" />
                <p className="mt-3 font-medium text-white">Spec-backed flow</p>
              </div>
              <div className="rounded-md border border-orange-200/15 bg-black/20 p-4">
                <BarChart3 className="h-5 w-5 text-orange-200" />
                <p className="mt-3 font-medium text-white">Transcript ready</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="agencies" className="bg-[#fff8f1] px-6 py-20 md:px-8 md:py-28">
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
              Agency-ready
            </p>
            <h2 className="mt-4 text-4xl font-semibold tracking-normal text-slate-950 md:text-5xl">
              Sell voice agents without rebuilding the operating layer.
            </h2>
            <p className="mt-5 text-lg leading-8 text-slate-600">
              Workspaces, client ownership, branding, usage, and analytics are part
              of the product story, so the landing page speaks to agencies and
              internal operators instead of only hobby demos.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-orange-200 bg-white p-6 shadow-sm shadow-orange-950/5">
              <Paintbrush className="h-6 w-6 text-orange-700" />
              <h3 className="mt-5 text-lg font-semibold text-slate-950">White-label control</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Brand client dashboards with custom colors, logos, and workspace-specific
                settings.
              </p>
            </div>
            <div className="rounded-lg border border-orange-200 bg-white p-6 shadow-sm shadow-orange-950/5">
              <Building2 className="h-6 w-6 text-orange-700" />
              <h3 className="mt-5 text-lg font-semibold text-slate-950">Client isolation</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                Client users only see their workspace, calls, agents, knowledge, and
                analytics.
              </p>
            </div>
            <div className="rounded-lg border border-orange-200 bg-white p-6 shadow-sm shadow-orange-950/5 sm:col-span-2">
              <p className="text-sm font-medium uppercase tracking-[0.18em] text-orange-700">
                Integration path
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                {integrations.map((integration) => (
                  <span
                    key={integration}
                    className="rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm font-medium text-stone-700"
                  >
                    {integration}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-[#211005] px-6 py-16 text-white md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
              VoiceForge AI
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-normal md:text-4xl">
              Build the first agent, test the first call, then ship it to a real workspace.
            </h2>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="h-12 bg-orange-400 px-6 text-[#211005] hover:bg-orange-300"
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
              className="h-12 border-orange-200/30 bg-white/10 px-6 text-white hover:bg-orange-300/15 hover:text-white"
            >
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-orange-200 bg-white px-6 py-10 md:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-semibold text-slate-950">VoiceForge AI</p>
            <p className="mt-1 text-sm text-slate-500">
              Spec-first voice agents for SaaS teams and agencies.
            </p>
          </div>
          <nav className="flex flex-wrap gap-5 text-sm text-stone-600">
            <Link href="/#product" className="transition hover:text-orange-800">
              Product
            </Link>
            <Link href="/#workflow" className="transition hover:text-orange-800">
              Workflow
            </Link>
            <Link href="/#compliance" className="transition hover:text-orange-800">
              Compliance
            </Link>
            <Link href="/#demo-call" className="transition hover:text-orange-800">
              Demo call
            </Link>
            <Link href="/#agencies" className="transition hover:text-orange-800">
              Agencies
            </Link>
            <Link href="/pricing" className="transition hover:text-orange-800">
              Pricing
            </Link>
            <Link href={demoSharePath} className="transition hover:text-orange-800">
              Share demo
            </Link>
            <Link href="/sign-up" className="transition hover:text-orange-800">
              Sign up
            </Link>
            <Link href="/sign-in" className="transition hover:text-orange-800">
              Sign in
            </Link>
          </nav>
          <p className="text-sm text-slate-500">&copy; 2026 VoiceForge AI</p>
        </div>
      </footer>
    </div>
  );
}
