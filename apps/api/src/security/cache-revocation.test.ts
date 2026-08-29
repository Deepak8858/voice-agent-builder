import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The three revocation methods on `CacheInvalidator` shipped as dead code:
 * defined, exported, and called by nothing. While they had zero callers,
 * every role gate in the API had a stale window equal to the cache TTL —
 * a demoted member kept their old role, an erased user kept authenticating,
 * and a logged-out bearer token kept working, all for up to 300 seconds.
 *
 * This ratchet pins each method to at least one production caller (outside
 * cache-invalidator.ts itself and outside tests), so revocation cannot rot
 * back into dead code when membership-mutation sites are refactored. If a
 * caller is deliberately removed, the mutation site it covered must either
 * be gone too or invalidate through another of these methods.
 */
describe('cache revocation cannot rot back into dead code', () => {
  const root = ((): string => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
      if (existsSync(path.join(dir, 'docs/RUNBOOK.md'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`could not locate repo root from ${process.cwd()}`);
  })();
  const apiSrc = path.join(root, 'apps/api/src');

  // Every production source file, CRLF-normalized: these files are CRLF on
  // Windows checkouts and LF in CI.
  const sources = ((): Array<{ rel: string; text: string }> => {
    const files: Array<{ rel: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
        if (entry === 'cache-invalidator.ts') continue;
        files.push({
          rel: path.relative(apiSrc, full),
          text: readFileSync(full, 'utf8').replace(/\r\n/g, '\n'),
        });
      }
    };
    walk(apiSrc);
    return files;
  })();

  const methods = [
    'invalidateWorkspaceList',
    'invalidateWorkspaceAccess',
    'invalidateSession',
    'invalidateOrgAccess',
  ] as const;

  for (const method of methods) {
    it(`${method} has at least one production caller`, () => {
      const callers = sources
        .filter(({ text }) => text.includes(`.${method}(`))
        .map(({ rel }) => rel);
      expect(callers.length, `no production code calls ${method}`).toBeGreaterThan(0);
    });
  }
});
