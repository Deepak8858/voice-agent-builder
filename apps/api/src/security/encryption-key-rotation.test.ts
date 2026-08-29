import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `ENCRYPTION_KEY` cannot be rotated, and nothing in the code says so.
 *
 * The AES-256-GCM envelope written by `encryption.service.ts` records `v`,
 * `alg`, `iv`, `tag` and `ciphertext` but **no key id**, and `resolveKey()`
 * loads exactly one key. Replacing the value therefore re-keys nothing — it
 * makes every stored ciphertext permanently undecryptable, including tenant
 * provider credentials and OAuth tokens. A database backup does not help: it
 * holds the ciphertext, not the key.
 *
 * Two places handed an operator that footgun. `docs/RUNBOOK.md` told them to
 * rotate it as step 1 of a security incident — i.e. exactly when they are moving
 * fast — and `scripts/generate-prod-env.js` regenerated it silently on every
 * run, reachable by no documentation, so no prose warning could ever have
 * stopped it. Both are fixed. This is the ratchet, because the damage is
 * invisible until someone decrypts a row written before the change.
 *
 * Remove this test only alongside a key-id/keyring migration that makes
 * rotation actually work.
 */
describe('ENCRYPTION_KEY is treated as unrotatable', () => {
  const root = ((): string => {
    let dir = process.cwd();
    for (let i = 0; i < 5; i += 1) {
      if (existsSync(path.join(dir, 'docs/RUNBOOK.md'))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`could not locate repo root from ${process.cwd()}`);
  })();
  // Normalized: these files are CRLF on Windows checkouts and LF in CI.
  const read = (rel: string): string =>
    readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

  it('no runbook line tells an operator to rotate it', () => {
    // Any line that mentions the variable and rotating it must also negate the
    // instruction. Wording-tolerant on purpose: the point is to fail when
    // someone reintroduces "rotate ENCRYPTION_KEY" in any phrasing.
    const offenders = read('docs/RUNBOOK.md')
      .split('\n')
      .filter((line) => line.includes('ENCRYPTION_KEY') && /rotat/i.test(line))
      .filter((line) => !/\b(?:do\s+(?:\*\*)?not|never|cannot|can't|must not)\b/i.test(line));

    expect(offenders).toEqual([]);
  });

  it('the runbook explains why, so the prohibition survives a skim', () => {
    expect(read('docs/RUNBOOK.md')).toContain('no key id');
  });

  it('generate-prod-env.js preserves an existing key instead of minting one', () => {
    const script = read('scripts/generate-prod-env.js');

    expect(script).toContain("existingValue('ENCRYPTION_KEY')");
    // Absent from .env is a hard stop, not a silent regeneration.
    expect(script).toMatch(/throw new Error\([\s\S]{0,200}ENCRYPTION_KEY/);
    expect(script).not.toMatch(/ENCRYPTION_KEY\s*=\s*\$\{?\s*crypto\./);
  });
});
