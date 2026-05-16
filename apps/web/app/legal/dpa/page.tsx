export const metadata = { title: 'Data Processing Agreement — VoiceForge' };

export default function DpaPage() {
  return (
    <div className="mx-auto max-w-3xl py-12 px-6">
      <h1 className="font-[family-name:var(--font-serif)] text-4xl">Data Processing Agreement</h1>
      <p className="mt-4 text-sm text-muted-foreground">Last updated: May 13, 2026</p>

      <div className="mt-8 space-y-8">
        <Section title="Data We Collect">
          We process: voice call audio, transcripts, caller phone numbers, call metadata (duration, outcome, timestamps).
          We do not process medical records or payment card data.
        </Section>

        <Section title="How We Use Your Data">
          Voice calls are processed by Vapi/Twilio for telephony. Audio is transcribed by Deepgram.
          Call metadata and transcripts are stored in Supabase. We do not sell your data.
        </Section>

        <Section title="Subprocessors">
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Vapi</strong> — Voice telephony and AI routing</li>
            <li><strong>Twilio</strong> — Voice telephony (optional)</li>
            <li><strong>Deepgram</strong> — Speech-to-text transcription</li>
            <li><strong>Supabase</strong> — Database and authentication</li>
            <li><strong>Resend</strong> — Transactional email</li>
          </ul>
        </Section>

        <Section title="Encryption">
          All data is encrypted in transit (TLS 1.2+). Data at rest uses AES-256 encryption
          via Supabase&apos;s storage layer. Encryption keys are managed via ENCRYPTION_KEY environment variable.
        </Section>

        <Section title="Retention">
          Call records are retained for 365 days by default. Organizations can configure
          retention between 30 and 3650 days in workspace settings.
          After retention period, records are permanently deleted.
        </Section>

        <Section title="Your Rights">
          You may request erasure of all personal data at any time. Contact privacy@voiceforge.ai
          or use the account deletion feature in your settings.
        </Section>

        <Section title="Contact">
          For data privacy inquiries: <a href="mailto:privacy@voiceforge.ai" className="text-primary underline">privacy@voiceforge.ai</a>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-6">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 text-sm text-muted-foreground leading-relaxed">{children}</div>
    </div>
  );
}
