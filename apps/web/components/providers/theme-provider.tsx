'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/** Shared with the pre-paint script in `app/layout.tsx`; keep both in step. */
export const THEME_STORAGE_KEY = 'voiceforge-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The preference lives in `localStorage` and the system setting lives in a media
 * query, so both are external stores rather than React state. Reading them with
 * `useSyncExternalStore` keeps the server render and the client in step without
 * an effect that sets state on mount, and it is what makes a same-tab write
 * visible to every consumer: the `storage` event only fires in other tabs.
 */
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribePreference(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // Private-mode Safari throws on localStorage access.
    return 'system';
  }
}

/**
 * `null` marks "not hydrated yet" so the toggle can hold a placeholder instead
 * of rendering a preference the user may not have chosen. Anything concrete
 * here would be a claim the server cannot make.
 */
function getServerPreference(): ThemePreference | null {
  return null;
}

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSystemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function getServerSystemDark(): boolean {
  return false;
}

export function useTheme() {
  const stored = useSyncExternalStore(subscribePreference, getPreference, getServerPreference);
  const systemDark = useSyncExternalStore(subscribeSystem, getSystemDark, getServerSystemDark);

  const preference: ThemePreference = stored ?? 'system';
  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Nothing to persist to; the emit below still switches the current page.
    }
    emit();
  }, []);

  return { preference, resolved, setPreference, mounted: stored !== null };
}

/**
 * Owns the `.dark` class on `<html>`.
 *
 * The class is first set before paint by the inline script in the root layout —
 * nothing in React runs early enough for that — so this only keeps it in step
 * with later changes to the preference or the system setting.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { resolved, mounted } = useTheme();

  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    root.classList.toggle('dark', resolved === 'dark');
    // Native widgets (scrollbars, date pickers, form controls) follow this, not
    // the class.
    root.style.colorScheme = resolved;
  }, [mounted, resolved]);

  return <>{children}</>;
}
