import Link from 'next/link';
import { Show, SignInButton, SignUpButton } from '@clerk/nextjs';

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-4 text-xs font-medium uppercase tracking-widest text-zinc-500">
          VoiceForge AI
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50">
          Build AI voice agents in minutes, not months.
        </h1>
        <p className="mt-5 text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Describe what your agent should do. VoiceForge generates the voice persona, call flow,
          knowledge base, tools, compliance settings, and white-label dashboard for your clients.
        </p>
        <div className="mt-10 flex items-center justify-center gap-3">
          <Show when="signed-out">
            <SignUpButton mode="modal">
              <button className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200">
                Get started free
              </button>
            </SignUpButton>
            <SignInButton mode="modal">
              <button className="rounded-md px-5 py-2.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900">
                Sign in
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/dashboard"
              className="rounded-md bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Open dashboard
            </Link>
          </Show>
        </div>
      </div>
      <div className="mt-16 grid w-full max-w-4xl grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          {
            title: 'Prompt to agent',
            body: 'Describe your agent; VoiceForge generates a full Agent Spec JSON you can edit.',
          },
          {
            title: 'Compliance-first',
            body: 'Consent, DNC/DND, opt-out, call window, and AI disclosure enforced by default.',
          },
          {
            title: 'White-label ready',
            body: 'Spin up agency + client workspaces, brand the dashboard, and sell voice agents.',
          },
        ].map((card) => (
          <div
            key={card.title}
            className="rounded-xl border border-zinc-200 bg-white p-5 text-left dark:border-zinc-800 dark:bg-zinc-950"
          >
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{card.title}</h3>
            <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">{card.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
