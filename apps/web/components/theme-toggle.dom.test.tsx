import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider, THEME_STORAGE_KEY } from '@/components/providers/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * The failure these guard against is silent and total: if the `.dark` class is
 * not applied to `<html>`, every dark token in `globals.css` stays inert and the
 * toggle appears to do nothing. The class is the whole mechanism, so it is what
 * gets asserted rather than any rendered colour.
 */

let systemDark = false;
const changeListeners = new Set<(event: MediaQueryListEvent) => void>();

function setSystemDark(next: boolean) {
  systemDark = next;
  for (const listener of changeListeners) {
    listener({ matches: next } as MediaQueryListEvent);
  }
}

beforeEach(() => {
  systemDark = false;
  changeListeners.clear();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('dark') ? systemDark : false,
        media: query,
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
          changeListeners.add(listener),
        removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
          changeListeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe('dark mode', () => {
  it('follows the system setting when no preference is stored', () => {
    setSystemDark(true);
    renderToggle();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('reacts to the system setting changing while the page is open', () => {
    renderToggle();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => setSystemDark(true));

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('cycles system to light to dark and persists each choice', () => {
    setSystemDark(true);
    renderToggle();

    // System resolves dark here, so the first click to light proves the explicit
    // preference wins over the media query rather than merely agreeing with it.
    act(() => screen.getByRole('button').click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => screen.getByRole('button').click());
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reads the stored preference on load, ignoring the system setting', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    setSystemDark(true);
    renderToggle();

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('treats an unknown stored value as system rather than trusting it', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    setSystemDark(true);
    renderToggle();

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
