import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../common/errors';
import { env, isProduction } from '../config/env';

/**
 * Key id of `ENCRYPTION_KEY` itself. Envelopes written before the keyring
 * existed carry no `kid` at all and are decrypted with this key forever, which
 * is why `ENCRYPTION_KEY` stays required and its value can never change.
 */
const LEGACY_KEY_ID = 'legacy';

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  /**
   * Which key in the ring encrypted this payload. Absent means LEGACY_KEY_ID:
   * the row predates the ring.
   *
   * `v` deliberately stays 1 while the shape gains a field. Four call sites
   * (workspace-crm, crm-fanout, calendar, google-connection) recognize a stored
   * envelope with a literal `v === 1` test and treat anything else as
   * plaintext, so bumping the version would make every newly written row read
   * back as its own envelope instead of failing. `kid`'s presence is the
   * discriminator instead, and it is a strict superset of the old shape.
   */
  kid?: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  /** kid -> 32-byte key. Always contains LEGACY_KEY_ID. */
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor() {
    this.keys.set(LEGACY_KEY_ID, this.resolveLegacyKey());
    // Format is validated in the env schema, so each pair splits into exactly
    // one kid and 64 hex characters here.
    const ring = (env.ENCRYPTION_KEYS ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => pair.split(':'));
    for (const [kid, hex] of ring) {
      if (this.keys.has(kid)) {
        throw new AppError(
          'INTERNAL_ERROR',
          `ENCRYPTION_KEYS declares the key id "${kid}" twice, or reuses "${LEGACY_KEY_ID}", ` +
            'which always belongs to ENCRYPTION_KEY. Shadowing a key id would make every row ' +
            'written under it undecryptable.',
          500,
        );
      }
      this.keys.set(kid, Buffer.from(hex, 'hex'));
    }
    // First entry wins, so rotating is "prepend the new key" while the older
    // ones stay listed and their rows keep decrypting.
    this.activeKeyId = ring.length > 0 ? ring[0][0] : LEGACY_KEY_ID;
  }

  encryptJson(value: unknown): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keyFor(this.activeKeyId), iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'aes-256-gcm',
      kid: this.activeKeyId,
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  decryptJson<T = unknown>(envelope: unknown): T {
    if (!this.isEnvelope(envelope)) {
      throw new AppError('INTERNAL_ERROR', 'Encrypted payload is malformed.', 500);
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.keyFor(envelope.kid ?? LEGACY_KEY_ID),
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  }

  mask(value: string | null | undefined): string | null {
    if (!value) return null;
    if (value.length <= 8) return `${value.slice(0, 2)}****`;
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
  }

  private keyFor(kid: string): Buffer {
    const key = this.keys.get(kid);
    if (!key) {
      // Loudly, never as a null/undefined plaintext: the only ways to get here
      // are a key dropped out of ENCRYPTION_KEYS or a restore from a deployment
      // that had more keys than this one, and both need an operator, not a
      // caller that quietly treats the credential as absent.
      throw new AppError(
        'INTERNAL_ERROR',
        `Encrypted payload was written with encryption key id "${kid.slice(0, 64)}", which is ` +
          'not in ENCRYPTION_KEYS. Restore that key id to decrypt this row.',
        500,
      );
    }
    return key;
  }

  private resolveLegacyKey(): Buffer {
    const raw = env.ENCRYPTION_KEY;
    if (!raw) {
      if (isProduction()) {
        throw new AppError('INTERNAL_ERROR', 'ENCRYPTION_KEY is required in production.', 500);
      }
      this.logger.warn(
        'ENCRYPTION_KEY is not set; using an ephemeral development key. Encrypted values will not survive restart.',
      );
      return randomBytes(32);
    }

    // No utf8 fallthrough: it accepted any 32-character passphrase, and 32
    // typed characters carry nowhere near 32 bytes of entropy, so a weak value
    // looked correctly configured. An encoded 32-byte key, or refuse to boot.
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    if (raw.length === 44) {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === 32) return decoded;
    }
    throw new AppError(
      'INTERNAL_ERROR',
      'ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters or 44 base64 ' +
        'characters, not a passphrase.',
      500,
    );
  }

  private isEnvelope(value: unknown): value is EncryptedEnvelope {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return (
      maybe.v === 1 &&
      maybe.alg === 'aes-256-gcm' &&
      (maybe.kid === undefined || typeof maybe.kid === 'string') &&
      typeof maybe.iv === 'string' &&
      typeof maybe.tag === 'string' &&
      typeof maybe.ciphertext === 'string'
    );
  }
}
