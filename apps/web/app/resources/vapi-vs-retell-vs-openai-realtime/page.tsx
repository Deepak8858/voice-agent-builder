import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'Vapi vs Retell vs OpenAI Realtime: How to Choose',
  'A build-versus-buy comparison of voice AI runtimes — cascaded pipelines against native speech-to-speech, observability trade-offs, and avoiding lock-in.',
  '/resources/vapi-vs-retell-vs-openai-realtime',
);

const faqs = [
  {
    question: 'What is the actual difference between these three?',
    answer:
      'Vapi is a developer-oriented voice API: you assemble and operate the control plane yourself. Retell is a platform for configuring and running individual agents through a dashboard. OpenAI Realtime is a native speech-to-speech model endpoint, not a product — it gives you low latency and expressive audio but no agent management, tenancy, or compliance layer. They are different altitudes, not three versions of the same thing.',
  },
  {
    question: 'Is native speech-to-speech better than a cascaded pipeline?',
    answer:
      'It is better at latency and acoustic nuance and worse at observability. A cascaded pipeline — speech to text, then a language model, then text to speech — gives you a text intermediate you can log, audit, and diff. Native speech-to-speech collapses that, so when a call goes wrong, “which stage failed” becomes much harder to answer. For regulated or client-facing calls, that text record is not overhead; it is the audit trail.',
  },
  {
    question: 'How do I avoid lock-in when choosing a runtime?',
    answer:
      'Keep the agent definition separate from the runtime that executes it. If your call flow, tools, guardrails, and compliance policy live in a provider dashboard, migrating means rebuilding. If they live in a portable, versioned specification, the runtime becomes a deployment choice. That is the whole argument for a provider-adapter architecture.',
  },
  {
    question: 'Which runtime does VoiceForge use?',
    answer:
      'Two: OpenAI Realtime on paid plans, and an in-house pipeline built on Azure Speech and Azure OpenAI that is the runtime available on the free plan. Agents are defined as runtime-neutral Agent Spec JSON, so a deployment can move between pipelines without being rebuilt. VoiceForge does not currently ship Vapi or Retell adapters.',
  },
  {
    question: 'When should I use a raw voice API instead of a platform?',
    answer:
      'When operating the control plane is the work you want to own — you have engineers, a single product surface, and no need to hand isolated workspaces to third-party clients. If you are deploying for multiple client businesses and the repeated cost is governance, delivery, and support rather than call handling, that operating layer is what you should stop rebuilding.',
  },
];

export default function RuntimeComparisonPage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'Vapi vs Retell vs OpenAI Realtime: How to Choose',
          description:
            'Comparing voice AI runtimes on the axes that matter in production: latency, observability, agent management, tenancy, and portability.',
          path: '/resources/vapi-vs-retell-vs-openai-realtime',
          datePublished: '2026-09-01',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          {
            name: 'Vapi vs Retell vs OpenAI Realtime',
            path: '/resources/vapi-vs-retell-vs-openai-realtime',
          },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Choosing a voice runtime"
        title="You are comparing three different altitudes"
        intro="Most comparisons of these tools line them up as competitors and score them on latency. They are not the same kind of thing: one is an API, one is an agent dashboard, one is a model endpoint. Choosing well means deciding which layer you intend to own — and keeping that decision reversible."
        sections={[
          {
            title: 'The three altitudes',
            body: 'OpenAI Realtime is a model endpoint. It gives you native speech-to-speech with impressive latency and expressiveness, and nothing else: no agent versioning, no tenancy, no compliance gate, no client reporting. Vapi is a developer API one level up — real primitives for building voice applications, with the control plane still yours to write and operate. Retell sits higher again, offering a dashboard where an individual agent can be configured and run. Comparing them on a single axis produces nonsense; the useful question is which layers you want to be responsible for at 2am.',
          },
          {
            title: 'Cascaded versus native: an observability trade, not a quality one',
            body: 'A cascaded pipeline transcribes speech to text, runs a language model, then synthesises audio. Native speech-to-speech skips the text. The native path wins on latency and on handling tone, overlap, and interruption naturally. The cascade wins on everything you need after a call goes wrong: a transcript that shows exactly what the system heard, what it decided, and what it said. For client-facing or regulated calling, that intermediate is the audit record — strip it out and you lose the ability to demonstrate what the agent was told and what it replied. Most production teams are right to take observability, and it is fine to run native where latency matters most and cascaded where accountability does.',
          },
          {
            title: 'Latency is a budget, not a number',
            body: 'Vendors quote model latency. Callers experience the whole loop: network, voice-activity detection deciding the caller finished, transcription, model inference, synthesis, playback, plus any tool call that has to complete before the agent can answer. A fast model behind slow turn detection still feels sluggish, and a tool call against a slow calendar API will dominate everything else. Measure the budget end to end on real calls before optimising the part a benchmark measures.',
          },
          {
            title: 'The question none of the three answers',
            body: 'What happens when a client asks for a change? On a raw API, someone edits code and hopes the test suite covered voice behaviour. In a dashboard, someone edits a prompt and the previous behaviour is gone. Neither leaves you able to say, six months later, what the agent is supposed to do or who changed it. This is the failure mode that has nothing to do with which runtime you picked — and it is the one that quietly destroys multi-client deployments.',
          },
          {
            title: 'Keep the contract portable',
            body: 'The way out is to stop treating the runtime as the source of truth. Put the agent’s goals, call flow, tools, guardrails, compliance policy, analytics, and handoff behaviour in a validated, versioned specification, and let an adapter translate that for whichever runtime executes the call. Then the runtime choice becomes a deployment decision you can revisit when pricing, latency, or model quality shifts — which in this market is every few months. VoiceForge runs OpenAI Realtime on paid plans and an in-house Azure Speech pipeline on the free plan behind exactly that interface.',
          },
          {
            title: 'A decision shortcut',
            body: 'If you are building one product surface with your own engineers and want the control plane, take a raw API and own it. If you need one agent configured quickly for one business, a dashboard product will get you there fastest. If you are deploying for multiple client businesses and your repeated cost is isolation, branding, versioned change, compliance and client reporting rather than call handling itself, then the runtime is not your problem and picking a different one will not fix it. Buy the operating layer and keep the runtime replaceable.',
          },
        ]}
        related={[
          { href: '/compare/vapi-alternative', label: 'VoiceForge vs Vapi for agencies' },
          { href: '/compare/retell-alternative', label: 'VoiceForge vs Retell for agencies' },
          { href: '/integrations', label: 'Supported runtimes and adapters' },
          { href: '/resources/why-voice-agents-fail', label: 'Why voice agents fail in production' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
