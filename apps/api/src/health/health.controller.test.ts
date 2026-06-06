import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import type { LlmAgentGenerator } from '../llm/llm.provider.interface';
import type { QueueService } from '../queue/queue.service';
import type { DatabaseHealthService } from './database-health.service';

describe('HealthController', () => {
  it('does not wait indefinitely for a hung database health query', async () => {
    vi.useFakeTimers();

    const databaseHealth = {
      check: vi.fn(() => new Promise(() => undefined)),
    } as unknown as DatabaseHealthService;
    const queue = {
      ping: vi.fn().mockResolvedValue('ok'),
    } as unknown as QueueService;
    const llm = {
      name: 'test-llm',
      generate: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue('ok'),
    } as unknown as LlmAgentGenerator;

    const check = new HealthController(databaseHealth, queue, llm).check();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    const result = await Promise.race([check, Promise.resolve(null)]);
    expect(result).toMatchObject({
      status: 'degraded',
      checks: {
        db: 'error',
        redis: 'ok',
        llm: { provider: 'test-llm', status: 'unavailable' },
      },
    });
    expect(llm.healthCheck).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not wait indefinitely for a hung LLM health check', async () => {
    vi.useFakeTimers();

    const databaseHealth = {
      check: vi.fn().mockResolvedValue('ok'),
    } as unknown as DatabaseHealthService;
    const queue = {
      ping: vi.fn().mockResolvedValue('ok'),
    } as unknown as QueueService;
    const llm = {
      name: 'test-llm',
      generate: vi.fn(),
      healthCheck: vi.fn(() => new Promise(() => undefined)),
    } as unknown as LlmAgentGenerator;

    const check = new HealthController(databaseHealth, queue, llm).check();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();

    const result = await Promise.race([check, Promise.resolve(null)]);
    expect(result).toMatchObject({
      status: 'degraded',
      checks: {
        db: 'ok',
        redis: 'ok',
        llm: { provider: 'test-llm', status: 'unavailable' },
      },
    });
    expect(llm.healthCheck).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
