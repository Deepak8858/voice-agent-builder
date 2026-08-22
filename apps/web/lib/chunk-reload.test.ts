import { describe, expect, it } from 'vitest';
import {
  RELOAD_COOLDOWN_MS,
  isChunkLoadError,
  shouldReloadForChunkError,
} from './chunk-reload';

describe('isChunkLoadError', () => {
  it('matches the ChunkLoadError name', () => {
    const error = new Error('Loading chunk 5385 failed.');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    'Loading chunk 5385 failed.',
    'Loading CSS chunk 12 failed.',
    'Failed to fetch dynamically imported module: https://app/_next/x.js',
    'Importing a module script failed.',
  ])('matches a chunk message: %s', (message) => {
    expect(isChunkLoadError(new Error(message))).toBe(true);
  });

  it.each(['TypeError: undefined is not a function', 'Network request failed'])(
    'ignores an unrelated message: %s',
    (message) => {
      expect(isChunkLoadError(new Error(message))).toBe(false);
    },
  );

  it('ignores a non-Error value', () => {
    expect(isChunkLoadError('Loading chunk 1 failed.')).toBe(false);
  });
});

describe('shouldReloadForChunkError', () => {
  const chunkError = new Error('Loading chunk 5385 failed.');

  it('reloads a chunk error when no reload happened before', () => {
    expect(shouldReloadForChunkError(chunkError, 1000, null)).toBe(true);
  });

  it('reloads again once the cooldown has passed', () => {
    expect(shouldReloadForChunkError(chunkError, RELOAD_COOLDOWN_MS + 1, 0)).toBe(true);
  });

  it('suppresses a repeat reload inside the cooldown window', () => {
    expect(shouldReloadForChunkError(chunkError, RELOAD_COOLDOWN_MS - 1, 0)).toBe(false);
  });

  it('never reloads for a non-chunk error', () => {
    expect(shouldReloadForChunkError(new Error('other'), 1000, null)).toBe(false);
  });
});
