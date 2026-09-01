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
          Voice calls are carried over LiveKit and Twilio. Call audio is handled by the voice runtime
          assigned to your plan — either OpenAI Realtime or our in-house pipeline on Microsoft Azure
          (Azure Speech for transcription and synthesis, Azure OpenAI for reasoning).
          Call metadata and transcripts are stored in Supabase. We do not sell your data.
        </Section>

        <Section title="Subprocessors">
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>LiveKit</strong> — Real-time audio transport</li>
            <li><strong>Twilio</strong> — Voice telephony (optional)</li>
            <li><strong>Vobiz</strong> — SIP voice telephony, if you connect a Vobiz number (optional)</li>
            <li><strong>OpenAI</strong> — Realtime voice runtime and language models</li>
            <li><strong>Microsoft Azure</strong> — Speech-to-text, text-to-speech, and Azure OpenAI</li>
            <li><strong>Google</strong> — Calendar, Gmail, and Sheets integrations (optional); Google Analytics for website usage analytics (Consent Mode v2 — analytics cookies are denied by default in regions requiring opt-in consent)</li>
            <li><strong>Supabase</strong> — Database and authentication</li>
            <li><strong>Dodo Payments</strong> — Payment processing as merchant of record (billing name, email, and address)</li>
            <li><strong>Resend</strong> — Transactional email</li>
          </ul>
          <p className="mt-3">
            Dodo Payments, Resend, and Google Analytics never receive call audio,
            transcripts, or caller phone numbers; call content reaches only the voice-path
            subprocessors above (LiveKit, Twilio, Vobiz, OpenAI, Microsoft Azure) and our
            database (Supabase).
          </p>
        </Section>

        <Section title="Encryption">
          Platform-managed data is encrypted in transit (TLS 1.2+) and at rest (AES-256);
          each subprocessor&apos;s encryption is governed by its own DPA. Integration
          credentials and access tokens are additionally envelope-encrypted with
          AES-256-GCM under rotatable, application-managed keys.
        </Section>

        <Section title="Retention">
          Call records are retained for 365 days by default. Organizations can configure
          retention between 30 and 3650 days in workspace settings.
          After retention period, records are permanently deleted.
        </Section>

        <Section title="Your Rights">
          You may request erasure of all personal data at any time: use the delete-account
          option in Settings, or contact privacy@incfrog.ai. Self-service deletion is
          refused when your organization still has other members (one person&apos;s request
          cannot delete teammates&apos; data — remove them or transfer ownership first) or an
          active subscription (cancel it first). Financial records must be retained by law,
          so accounts with billing history cannot be hard-deleted automatically — contact
          privacy@incfrog.ai and remaining personal data will be removed from those records.
        </Section>

        <Section title="Contact">
          For data privacy inquiries: <a href="mailto:privacy@incfrog.ai" className="text-primary underline">privacy@incfrog.ai</a>
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
