import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

describe('env validation', () => {
  afterEach(() => {
    restoreEnv();
    vi.resetModules();
  });

  it('requires VOICE_WEBHOOK_SECRET in production', async () => {
    vi.resetModules();
    restoreEnv();
    Object.assign(process.env, {
      NODE_ENV: 'production',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'production-jwt-secret-with-32-chars',
    });
    delete process.env.VOICE_WEBHOOK_SECRET;

    await expect(import('./env')).rejects.toThrow(/VOICE_WEBHOOK_SECRET/);
  });
});
