import { describe, it, expect, vi, beforeEach } from 'vitest';

const connectMock = vi.fn(async () => undefined);
let redisStatus = 'wait';

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    get status() {
      return redisStatus;
    },
    connect: connectMock,
    on: vi.fn(),
    quit: vi.fn(),
  })),
}));

import { QueueService } from './queue.service';

describe('QueueService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStatus = 'wait';
  });

  /**
   * lazyConnect + enableOfflineQueue:false fail the first command outright
   * while the socket is still connecting; boot must warm the connection so a
   * live call path is never the first thing to touch Redis.
   */
  it('connects the shared connection eagerly at module init', async () => {
    await new QueueService().onModuleInit();

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when the connection is already active', async () => {
    redisStatus = 'ready';

    await new QueueService().onModuleInit();

    expect(connectMock).not.toHaveBeenCalled();
  });

  it('survives an eager-connect failure so boot never depends on Redis', async () => {
    connectMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(new QueueService().onModuleInit()).resolves.toBeUndefined();
  });
});
