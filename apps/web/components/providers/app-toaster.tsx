'use client';

import { Toaster } from 'sonner';
import { useTheme } from '@/components/providers/theme-provider';

/**
 * Sonner paints its own surface, so it needs the resolved theme handed to it —
 * its own `system` setting reads `prefers-color-scheme` and would ignore an
 * explicit light/dark choice made in the app.
 */
export function AppToaster() {
  const { resolved, mounted } = useTheme();
  return <Toaster richColors position="top-right" theme={mounted ? resolved : 'light'} />;
}
