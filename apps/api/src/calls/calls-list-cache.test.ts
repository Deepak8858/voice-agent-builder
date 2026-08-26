import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';
import type { CallSummary } from '@voiceforge/shared';

const callRow = {
  id: 'call-1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  agentVersionId: 'version-1',
  direction: 'browser_test',
  status: 'completed',
  provider: 'openai-realtime',
  fromNumber: null,
  toNumber: null,
  contactName: 'Tester',
  durationSeconds: 12,
  outcome: 'test_completed',
  startedAt: new Date('2026-06-01T10:00:00.000Z'),
  endedAt: new Date('2026-06-01T10:00:12.000Z'),
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
};

function makeService(cacheOverrides?: Record<string, unknown>) {
  const prisma = {
    call: {
      findMany: vi.fn(async () => [callRow]),
    },
  };
  const cache = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    ...(cacheOverrides ?? {}),
  };

  const service = new CallsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    cache as never,
    {} as never,
    {} as never,
  );

  return { service, prisma, cache };
}

describe('CallsService.list cache', () => {
  it('returns cached call summaries without hitting Postgres', async () => {
    const cached: CallSummary[] = [
      {
        id: 'call-cached',
        workspace_id: 'ws-1',
        agent_id: 'agent-1',
        agent_version_id: 'version-1',
        direction: 'browser_test',
        status: 'completed',
        provider: 'openai-realtime',
        pipeline: 'realtime',
        from_number: null,
        to_number: null,
        contact_name: 'Cached tester',
        duration_seconds: 4,
        outcome: 'test_completed',
        started_at: '2026-06-01T10:00:00.000Z',
        ended_at: '2026-06-01T10:00:04.000Z',
        created_at: '2026-06-01T10:00:00.000Z',
      },
    ];
    const { service, prisma, cache } = makeService({
      get: vi.fn(async () => cached),
    });

    await expect(service.list('ws-1')).resolves.toEqual(cached);
    expect(cache.get).toHaveBeenCalledWith('calls:list:ws-1:all');
    expect(prisma.call.findMany).not.toHaveBeenCalled();
  });

  it('caches the recent call list after a Postgres read', async () => {
    const { service, cache } = makeService();

    const result = await service.list('ws-1', 'agent-1');

    expect(result).toHaveLength(1);
    expect(cache.set).toHaveBeenCalledWith(
      'calls:list:ws-1:agent-1',
      result,
      15,
    );
  });
});
