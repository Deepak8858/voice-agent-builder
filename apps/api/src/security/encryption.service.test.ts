import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EncryptionService } from './encryption.service';

/**
 * The keyring. Before it existed, every ciphertext was written with the single
 * `ENCRYPTION_KEY` and recorded no key id, so `ENCRYPTION_KEY` can never change
 * — and `resolveLegacyKey` accepted any 32-character string as a key, so a
 * passphrase produced an AES-256 key with almost none of its keyspace used.
 *
 * These tests pin the three properties that make the ring safe: a new ciphertext
 * names its key, an old one without a name still decrypts, and a name we do not
 * hold fails loudly instead of handing back an absent credential.
 */

// 32 bytes each, in the 64-hex form the schema requires.
const LEGACY_KEY = '11'.repeat(32);
const KEY_A = '22'.repeat(32);
const KEY_B = '33'.repeat(32);

const originalEnv = { ...process.env };
// A ring in the developer's own shell or .env would otherwise leak into the
// cases that assert the unset-ring default.
delete originalEnv.ENCRYPTION_KEYS;

async function makeService(overrides: Record<string, string> = {}): Promise<EncryptionService> {
  vi.resetModules();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv, { ENCRYPTION_KEY: LEGACY_KEY }, overrides);
  const module = await import('./encryption.service');
  return new module.EncryptionService();
}

/** The envelope shape as it reaches the database, key id included. */
function envelopeOf(service: EncryptionService, value: unknown): Record<string, unknown> {
  return service.encryptJson(value) as unknown as Record<string, unknown>;
}

describe('EncryptionService keyring', () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  it('stamps every new ciphertext with the active key id and round-trips it', async () => {
    const service = await makeService({ ENCRYPTION_KEYS: `k2026:${KEY_A}` });
    const envelope = envelopeOf(service, { api_key: 'secret' });

    expect(envelope.kid).toBe('k2026');
    expect(service.decryptJson(envelope)).toEqual({ api_key: 'secret' });
  });

  it('uses ENCRYPTION_KEY under the key id "legacy" when no ring is configured', async () => {
    const service = await makeService();
    const envelope = envelopeOf(service, 'token');

    expect(envelope.kid).toBe('legacy');
    expect(service.decryptJson(envelope)).toBe('token');
  });

  /**
   * The whole point of the ring: prepending a key must not orphan the rows the
   * previous one wrote.
   */
  it('decrypts a row written under a key that is no longer the active one', async () => {
    const before = await makeService({ ENCRYPTION_KEYS: `k1:${KEY_A}` });
    const envelope = envelopeOf(before, { refresh: 'r1' });
    expect(envelope.kid).toBe('k1');

    const after = await makeService({ ENCRYPTION_KEYS: `k2:${KEY_B},k1:${KEY_A}` });
    expect(envelopeOf(after, 'new').kid).toBe('k2');
    expect(after.decryptJson(envelope)).toEqual({ refresh: 'r1' });
  });

  /**
   * Rows written before the ring existed carry no `kid` at all. They must keep
   * decrypting with ENCRYPTION_KEY forever, including on a deployment whose
   * active key is a ring entry.
   */
  it('decrypts a pre-keyring envelope that has no key id', async () => {
    const legacyOnly = await makeService();
    const v1 = envelopeOf(legacyOnly, { api_key: 'old-secret' });
    delete v1.kid;
    expect(Object.keys(v1).sort()).toEqual(['alg', 'ciphertext', 'iv', 'tag', 'v']);

    const withRing = await makeService({ ENCRYPTION_KEYS: `k2026:${KEY_A}` });
    expect(withRing.decryptJson(v1)).toEqual({ api_key: 'old-secret' });
  });

  /**
   * A dropped key id must not read back as an absent credential — callers treat
   * a non-envelope or an empty result as "not configured" and would carry on
   * with no credentials at all.
   */
  it('throws naming the unknown key id instead of returning nothing', async () => {
    const service = await makeService({ ENCRYPTION_KEYS: `k1:${KEY_A}` });
    const envelope = envelopeOf(service, { api_key: 'secret' });
    envelope.kid = 'retired-key';

    expect(() => service.decryptJson(envelope)).toThrow(/retired-key/);
    expect(() => service.decryptJson(envelope)).toThrow(/ENCRYPTION_KEYS/);
  });

  /**
   * `legacy` is ENCRYPTION_KEY's own id. Letting a ring entry shadow it would
   * silently make every pre-keyring row undecryptable, which is exactly the
   * failure the ring exists to prevent.
   */
  it.each([
    ['shadows the legacy key id', `legacy:${KEY_A}`],
    ['declares one key id twice', `k1:${KEY_A},k1:${KEY_B}`],
  ])('refuses to boot when the ring %s', async (_label, keys) => {
    await expect(makeService({ ENCRYPTION_KEYS: keys })).rejects.toThrow(/ENCRYPTION_KEYS/);
  });

  /**
   * The removed fallthrough: `Buffer.from(raw, 'utf8')` turned any 32-character
   * passphrase into a "valid" AES-256 key.
   */
  it.each([
    ['a 32-character passphrase', 'correct-horse-battery-staple-123'],
    ['63 hex characters', '11'.repeat(31) + '1'],
    ['44 base64 characters that decode to 31 bytes', 'a'.repeat(42) + '=='],
  ])('refuses %s as ENCRYPTION_KEY', async (_label, key) => {
    await expect(makeService({ ENCRYPTION_KEY: key })).rejects.toThrow(/ENCRYPTION_KEY/);
  });

  it('still accepts a 44-character base64 key that decodes to 32 bytes', async () => {
    const base64 = Buffer.from(KEY_A, 'hex').toString('base64');
    expect(base64).toHaveLength(44);
    const service = await makeService({ ENCRYPTION_KEY: base64 });

    expect(service.decryptJson(envelopeOf(service, 'ok'))).toBe('ok');
  });
});
