import { SeoPage } from '@/components/marketing/seo-page';
import { JsonLd, breadcrumbJsonLd, faqJsonLd, pageMetadata, techArticleJsonLd } from '@/lib/seo';

export const metadata = pageMetadata(
  'Why AI Voice Agents Fail in Production',
  'It is rarely the model. Voice agents fail on state, interruptions, transfers, and unversioned changes — the parts a demo never exercises. Here is the failure map.',
  '/resources/why-voice-agents-fail',
);

const faqs = [
  {
    question: 'Why do AI voice agents work in demos but fail on real calls?',
    answer:
      'Because a demo exercises the happy path once, and production exercises everything else at once: callers who interrupt, go silent mid-sentence, ask two things in one breath, or need a transfer while another call is mid-tool-call. The model is usually fine. The system around it — state isolation, turn detection, transfer logic, versioning — is what breaks.',
  },
  {
    question: 'What is the most common production failure?',
    answer:
      'Unreviewable change. Someone edits a prompt to fix one client call, nobody records what changed, and a different behavior quietly breaks. Six months later no one can say what the agent is supposed to do. This is why VoiceForge stores agents as versioned Agent Spec JSON: every change is a diff you can read, test, and roll back.',
  },
  {
    question: 'How should interruptions be handled?',
    answer:
      'Both directions matter. Barge-in — the caller talks over the agent — needs real voice-activity detection and cancellation. The opposite case is worse: a caller pauses four seconds mid-thought, the system calls it end-of-turn, and the agent answers half a question. Turn detection failures read as stupidity in transcripts even when the model never erred.',
  },
  {
    question: 'How do you test a voice agent before it takes real calls?',
    answer:
      'Run the complete call path in a browser against the exact version you intend to publish: live transcript, event stream, tool activity, and outcome — before any phone number is attached. Test transfers, silences, interruptions, and the caller who refuses every option. Our testing checklist covers the paths that break most.',
  },
];

export default function WhyVoiceAgentsFailPage() {
  return (
    <>
      <JsonLd
        data={techArticleJsonLd({
          headline: 'Why AI Voice Agents Fail in Production',
          description:
            'The production failure map for AI voice agents: state, turn detection, transfers, tool calls, and unversioned change — not the model.',
          path: '/resources/why-voice-agents-fail',
          datePublished: '2026-09-01',
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
          { name: 'Why voice agents fail', path: '/resources/why-voice-agents-fail' },
        ])}
      />
      <JsonLd data={faqJsonLd(faqs)} />
      <SeoPage
        eyebrow="Reliability engineering for voice"
        title="It is almost never the model"
        intro="Every voice-agent post-mortem we have seen or run blames the model first and finds the system second. The model produced a reasonable sentence; the platform fed it the wrong state, cut the caller off, lost the transfer, or ran a version nobody had reviewed. This is the failure map — and what a beautiful demo never shows you."
        sections={[
          {
            title: 'Failure 1: shared state between calls',
            body: 'One conversation works. Forty concurrent conversations expose every place your architecture shares context — history bleeding between callers, a tool result landing in the wrong session, an agent answering caller B with caller A\u2019s appointment. Session isolation is not an optimization; it is the difference between a product and an incident. Every call needs its own state, history, audio stream, and tool-execution context, with nothing shared by default.',
          },
          {
            title: 'Failure 2: turn detection, both directions',
            body: 'Barge-in gets the attention: the caller interrupts, the agent must stop talking and cancel downstream work. The quieter killer is premature end-of-turn: a caller pauses mid-sentence to find an order number, voice-activity detection declares the turn over, and the agent confidently answers a half-question. In the transcript this reads as a stupid agent. The model never erred — the detection did. Test silences as deliberately as interruptions.',
          },
          {
            title: 'Failure 3: the transfer that drops the context',
            body: 'The highest-stakes moment in a business call is the handoff to a human — and it is where voice deployments fail most expensively, because the caller has already spent their patience. A transfer needs the human to receive who is calling, why, and what the agent already collected. If your platform treats transfer as \u201cdial a number and hope,\u201d every escalation deletes the work the agent just did.',
          },
          {
            title: 'Failure 4: tool calls without guardrails',
            body: 'A voice agent that books appointments is executing writes against a real calendar under a nondeterministic controller. Every tool call needs validation before execution, permission checks per client, idempotency where the action allows it, and a log entry regardless. The failure mode without this is not a bad conversation — it is double-booked appointments and phantom orders that a client discovers before you do.',
          },
          {
            title: 'Failure 5: the unversioned prompt edit',
            body: 'The most common failure has no incident at all. A client asks for a change; someone edits the prompt in a dashboard; the change fixes their case and quietly shifts three other behaviors. Repeat for six months and nobody — not the agency, not the client, not the person who made the edits — can state what the agent is supposed to do. This is why VoiceForge treats the agent as a versioned Agent Spec JSON contract: changes are diffs, diffs are reviewable, versions are testable, and rollback is a selection rather than an archaeology project.',
          },
          {
            title: 'What the demo was never going to tell you',
            body: 'A demo is one call on the happy path with a cooperative speaker and zero concurrency. Production is the caller with a barking dog, the double question, the mid-call transfer during peak load, and the client who wants one behavior changed by Friday. The fix is not a better demo — it is running the full call path against a known version before telephony is attached, and keeping every subsequent change reviewable. That loop is the product.',
          },
        ]}
        related={[
          { href: '/resources/test-ai-voice-agent', label: 'The pre-launch testing checklist' },
          { href: '/how-it-works', label: 'Spec → test → publish workflow' },
          { href: '/resources/white-label-ai-voice-agents', label: 'Operating agents for clients' },
          { href: '/compliance', label: 'The compliance gate' },
        ]}
        faqs={faqs}
      />
    </>
  );
}
