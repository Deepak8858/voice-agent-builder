import { ClerkProvider } from '@clerk/nextjs';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <div className="min-h-full flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
        {children}
      </div>
    </ClerkProvider>
  );
}
