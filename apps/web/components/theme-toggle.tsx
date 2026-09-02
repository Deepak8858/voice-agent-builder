'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useTheme, type ThemePreference } from '@/components/providers/theme-provider';

const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

const META: Record<ThemePreference, { icon: typeof Sun; label: string }> = {
  system: { icon: Monitor, label: 'System theme' },
  light: { icon: Sun, label: 'Light theme' },
  dark: { icon: Moon, label: 'Dark theme' },
};

/**
 * Cycles system → light → dark. Renders a same-size placeholder until the
 * provider has read `localStorage`, so the icon never shows a preference the
 * user did not pick and the surrounding layout does not shift.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { preference, setPreference, mounted } = useTheme();

  if (!mounted) {
    return <div className={cn('h-9 w-9 shrink-0', className)} aria-hidden />;
  }

  const { icon: Icon, label } = META[preference];
  const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn('shrink-0', className)}
      onClick={() => setPreference(next)}
      title={`${label} — switch to ${META[next].label.toLowerCase()}`}
      aria-label={`${label}. Switch to ${META[next].label.toLowerCase()}.`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
