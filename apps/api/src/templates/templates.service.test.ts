import { describe, expect, it, vi } from 'vitest';
import { TemplatesService } from './templates.service';

describe('TemplatesService cache', () => {
  it('serves the public template list from Redis when available', async () => {
    const cached = [
      {
        slug: 'cached-template',
        name: 'Cached template',
        description: 'Loaded from Redis',
        industry: 'general',
        agent_type: 'inbound',
      },
    ];
    const prisma = {
      agentTemplate: {
        findMany: vi.fn(async () => {
          throw new Error('template list should be cached');
        }),
      },
    };
    const cache = {
      get: vi.fn(async () => cached),
      set: vi.fn(async () => undefined),
    };
    const service = new TemplatesService(prisma as never, cache as never);

    await expect(service.list()).resolves.toEqual(cached);
    expect(cache.get).toHaveBeenCalledWith('templates:list:public');
    expect(prisma.agentTemplate.findMany).not.toHaveBeenCalled();
  });

  it('caches database template lists for subsequent dashboard tab loads', async () => {
    const prisma = {
      agentTemplate: {
        findMany: vi.fn(async () => [
          {
            slug: 'db-template',
            name: 'DB template',
            description: 'Loaded from Postgres',
            industry: 'sales',
            agentType: 'outbound',
          },
        ]),
      },
    };
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    const service = new TemplatesService(prisma as never, cache as never);

    const result = await service.list();

    expect(result).toEqual([
      {
        slug: 'db-template',
        name: 'DB template',
        description: 'Loaded from Postgres',
        industry: 'sales',
        agent_type: 'outbound',
      },
    ]);
    expect(cache.set).toHaveBeenCalledWith('templates:list:public', result, 300);
  });
});
