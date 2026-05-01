import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { InviteAcceptClient } from '@/components/invite-accept-client';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function InviteAcceptPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-xl font-semibold">Missing invitation token</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The invite link is invalid. Ask the inviter to resend.
        </p>
      </main>
    );
  }

  const { userId } = await auth();
  if (!userId) {
    const returnTo = `/invite/accept?token=${encodeURIComponent(token)}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
      <InviteAcceptClient token={token} />
    </main>
  );
}
