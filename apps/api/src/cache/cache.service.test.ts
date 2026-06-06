import { describe, expect, it, vi } from 'vitest';
import { CacheService } from './cache.service';

describe('CacheService Redis readiness', () => {
  it('returns a miss without issuing commands while Redis is still connecting', async () => {
    const connection = {
      status: 'connecting',
      get: vi.fn(async () => {
        throw new Error('should not call Redis before it is ready');
      }),
    };
    const queue = {
      getConnection: vi.fn(() => connection),
    };
    const cache = new CacheService(queue as never);

    await expect(cache.get('templates:list:public')).resolves.toBeNull();
    expect(connection.get).not.toHaveBeenCalled();
  });

  it('does not create a Redis connection while checking cache readiness', async () => {
    const queue = {
      getExistingConnection: vi.fn(() => null),
      getConnection: vi.fn(() => {
        throw new Error('should not create Redis connection during cache readiness check');
      }),
    };
    const cache = new CacheService(queue as never);

    await expect(cache.get('templates:list:public')).resolves.toBeNull();
    expect(queue.getExistingConnection).toHaveBeenCalled();
    expect(queue.getConnection).not.toHaveBeenCalled();
  });
});
