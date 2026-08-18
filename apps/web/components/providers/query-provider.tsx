'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * The cache is per browser session (in memory, never persisted), so it is
 * inherently scoped to one user — and `AuthGate` clears it on sign-out so a
 * shared machine cannot surface the previous user's data.
 *
 * `staleTime` was 30s, which meant almost every revisit refetched and blocked
 * the panel on a round trip. Five minutes lets a revisited panel render from
 * cache instantly and revalidate in the background; `gcTime` keeps the entry
 * around long enough for a user to navigate away and come back.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60_000,
            gcTime: 30 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
