'use client';

/**
 * Recovery for a stale JavaScript chunk after a deploy.
 *
 * A deploy replaces the hashed chunk files under `/_next/static/chunks`. A
 * browser that still holds the previous page names the old files, but the
 * server now serves only the new ones, so the next dynamic import throws a
 * `ChunkLoadError`. React hands that error to the nearest boundary, whose
 * `reset()` re-renders the same tree and requests the same missing file again —
 * the failure repeats and the app stays unusable. Only a full page load, which
 * fetches fresh HTML that names the current chunks, recovers.
 */

/** sessionStorage key that records the last automatic reload time, in ms. */
const RELOAD_MARKER = 'vf:last-chunk-reload';

/**
 * Suppression window for a repeat reload.
 *
 * A reload that does not fix the error must not repeat: if a chunk is genuinely
 * gone the fresh load fails too, and an unguarded reload would loop forever. A
 * second chunk error inside this window keeps the fallback visible instead.
 */
export const RELOAD_COOLDOWN_MS = 10_000;

/** True when the error is a failed chunk or dynamic-import load. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  const message = error.message;
  return (
    /Loading (?:CSS )?chunk [\w-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message)
  );
}

/**
 * Decides whether a chunk error should trigger a reload now. Pure so the loop
 * guard is testable without a browser: reload only for a chunk error, and not
 * when the previous reload was inside the cooldown window.
 */
export function shouldReloadForChunkError(
  error: unknown,
  now: number,
  lastReloadAt: number | null,
): boolean {
  if (!isChunkLoadError(error)) return false;
  if (lastReloadAt !== null && now - lastReloadAt < RELOAD_COOLDOWN_MS) return false;
  return true;
}

/**
 * Reloads the page once to recover from a stale chunk. Returns true when a
 * reload was started. The last attempt time is held in sessionStorage; when it
 * is unreachable, recovery is skipped rather than risk an unguarded loop.
 */
export function recoverFromChunkError(error: unknown): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const storage = window.sessionStorage;
    const now = Date.now();
    const raw = storage.getItem(RELOAD_MARKER);
    const parsed = raw === null ? Number.NaN : Number(raw);
    const lastReloadAt = Number.isFinite(parsed) ? parsed : null;

    if (!shouldReloadForChunkError(error, now, lastReloadAt)) return false;
    storage.setItem(RELOAD_MARKER, String(now));
  } catch {
    return false;
  }

  window.location.reload();
  return true;
}
