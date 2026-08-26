import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Job } from 'bullmq';
import { AgentGenWorker } from './agent-gen.worker';
import type { AgentGenJobPayload } from '../agent-gen/agent-gen.service';

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

const mockQueueService = {
  getConnection: vi.fn().mockReturnValue({}),
  getBullMqConnection: vi.fn().mockReturnValue({}),
};

const mockSessions = {
  processGeneration: vi.fn().mockResolvedValue(undefined),
};

function build(): AgentGenWorker {
  return new AgentGenWorker(mockQueueService as never, mockSessions as never);
}

function job(attemptsMade: number, attempts?: number): Job<AgentGenJobPayload> {
  return {
    data: { sessionId: 'session-1', workspaceId: 'ws-1', template_slug: 'ai-receptionist' },
    attemptsMade,
    opts: attempts === undefined ? {} : { attempts },
  } as Job<AgentGenJobPayload>;
}

describe('AgentGenWorker.processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessions.processGeneration.mockResolvedValue(undefined);
  });

  it('delegates the job payload to AgentGenService.processGeneration', async () => {
    await build().processor(job(0, 2));

    expect(mockSessions.processGeneration).toHaveBeenCalledTimes(1);
    expect(mockSessions.processGeneration).toHaveBeenCalledWith(
      { sessionId: 'session-1', workspaceId: 'ws-1', template_slug: 'ai-receptionist' },
      expect.any(Boolean),
    );
  });

  it('marks the first of two attempts as non-final', async () => {
    await build().processor(job(0, 2));

    expect(mockSessions.processGeneration).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('marks the second of two attempts as final', async () => {
    await build().processor(job(1, 2));

    expect(mockSessions.processGeneration).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('treats a job with no attempts option as a single, final attempt', async () => {
    await build().processor(job(0));

    expect(mockSessions.processGeneration).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('propagates errors so BullMQ can retry the job', async () => {
    mockSessions.processGeneration.mockRejectedValueOnce(new Error('provider down'));

    await expect(build().processor(job(0, 2))).rejects.toThrow('provider down');
  });
});
