import { NotFoundException } from '@nestjs/common';
import { MVP_TEMPLATES } from '@voiceforge/shared';
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

describe('TemplatesService.getBySlug visibility', () => {
  const dbRow = (overrides: Record<string, unknown>) => ({
    slug: 'db-template',
    name: 'DB template',
    description: 'Loaded from Postgres',
    industry: 'sales',
    agentType: 'outbound',
    templateSpec: { agent_type: 'outbound' },
    isPublic: true,
    ...overrides,
  });

  const makeService = (row: Record<string, unknown> | null) =>
    new TemplatesService(
      { agentTemplate: { findUnique: vi.fn(async () => row) } } as never,
      { get: vi.fn(async () => null), set: vi.fn(async () => undefined) } as never,
    );

  it('returns a public database row with its spec', async () => {
    await expect(makeService(dbRow({})).getBySlug('db-template')).resolves.toMatchObject({
      slug: 'db-template',
      agent_type: 'outbound',
      template_spec: { agent_type: 'outbound' },
    });
  });

  /**
   * The regression case (A-008): `isPublic` was ignored, so any authenticated
   * user could fetch a private template's full spec by slug. A private row
   * must 404 — and must not fall through to the seed copy of the same slug,
   * since the row is the operator's word on that slug's visibility.
   */
  it('hides a private row instead of serving it or its seed copy', async () => {
    const seedSlug = MVP_TEMPLATES[0].slug;

    await expect(
      makeService(dbRow({ slug: seedSlug, isPublic: false })).getBySlug(seedSlug),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still serves the seed catalogue when no row exists', async () => {
    const seedSlug = MVP_TEMPLATES[0].slug;

    await expect(makeService(null).getBySlug(seedSlug)).resolves.toMatchObject({
      slug: seedSlug,
    });
  });

  it('404s an unknown slug', async () => {
    await expect(makeService(null).getBySlug('no-such-template')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
