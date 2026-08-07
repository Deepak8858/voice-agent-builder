import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppError } from '../common/errors';
import { env, isProduction } from '../config/env';

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer;

  constructor() {
    this.key = this.resolveKey();
  }

  encryptJson(value: unknown): EncryptedEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'aes-256-gcm',
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
      this.key,
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

  private resolveKey(): Buffer {
    if (!env.ENCRYPTION_KEY) {
      if (isProduction()) {
        throw new AppError('INTERNAL_ERROR', 'ENCRYPTION_KEY is required in production.', 500);
      }
      this.logger.warn(
        'ENCRYPTION_KEY is not set; using an ephemeral development key. Encrypted values will not survive restart.',
      );
      return randomBytes(32);
    }

    const raw = env.ENCRYPTION_KEY;
    const key = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, 'hex')
      : raw.length === 44
        ? Buffer.from(raw, 'base64')
        : Buffer.from(raw, 'utf8');
    if (key.length !== 32) {
      throw new AppError('INTERNAL_ERROR', 'ENCRYPTION_KEY must be exactly 32 bytes.', 500);
    }
    return key;
  }

  private isEnvelope(value: unknown): value is EncryptedEnvelope {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return (
      maybe.v === 1 &&
      maybe.alg === 'aes-256-gcm' &&
      typeof maybe.iv === 'string' &&
      typeof maybe.tag === 'string' &&
      typeof maybe.ciphertext === 'string'
    );
  }
}
