import { describe, expect, it } from 'vitest';
import { createFakePrisma, matchesWhere } from './tenant-fake-prisma';

/**
 * The cross-tenant suite is only as trustworthy as the fake it runs against.
 * If `matchesWhere` silently ignored a predicate, every isolation test would
 * pass vacuously. These tests pin the matcher's semantics.
 */
describe('tenant-fake-prisma matcher', () => {
  const row = { id: 'a1', workspaceId: 'ws-a', phone: '+15550001', optOut: false };

  it('treats an absent where as matching everything, which is the leak shape under test', () => {
    expect(matchesWhere(row, undefined)).toBe(true);
    expect(matchesWhere(row, {})).toBe(true);
  });

  it('rejects a row whose workspaceId differs from the predicate', () => {
    expect(matchesWhere(row, { id: 'a1', workspaceId: 'ws-a' })).toBe(true);
    expect(matchesWhere(row, { id: 'a1', workspaceId: 'ws-b' })).toBe(false);
  });

  it('evaluates compound unique selectors field by field', () => {
    expect(matchesWhere(row, { workspaceId_phone: { workspaceId: 'ws-a', phone: '+15550001' } })).toBe(true);
    expect(matchesWhere(row, { workspaceId_phone: { workspaceId: 'ws-b', phone: '+15550001' } })).toBe(false);
  });

  it('supports in / not / OR operators', () => {
    expect(matchesWhere(row, { id: { in: ['a1', 'a2'] } })).toBe(true);
    expect(matchesWhere(row, { id: { in: ['b1'] } })).toBe(false);
    expect(matchesWhere(row, { optOut: { not: true } })).toBe(true);
    expect(matchesWhere(row, { OR: [{ workspaceId: 'ws-b' }, { workspaceId: 'ws-a' }] })).toBe(true);
    expect(matchesWhere(row, { OR: [{ workspaceId: 'ws-b' }, { workspaceId: 'ws-c' }] })).toBe(false);
  });

  it('refuses to silently pass an unmodelled relation filter', () => {
    expect(() => matchesWhere(row, { agent: { workspaceId: 'ws-a' } })).toThrow(/relation filters are not supported/);
  });

  it('exposes no delegate for a model the test did not seed, so a typo throws', () => {
    const prisma = createFakePrisma({ agent: [] });
    expect(prisma['agent']).toBeDefined();
    expect(prisma['call']).toBeUndefined();
  });

  it('scopes updateMany and deleteMany to matching rows only', async () => {
    const prisma = createFakePrisma({
      twilioPhoneNumber: [
        { id: 'num-a', workspaceId: 'ws-a', agentId: null },
        { id: 'num-b', workspaceId: 'ws-b', agentId: null },
      ],
    });
    const numbers = prisma['twilioPhoneNumber'] as {
      updateMany: (a: unknown) => Promise<{ count: number }>;
      deleteMany: (a: unknown) => Promise<{ count: number }>;
    };

    const blocked = await numbers.updateMany({
      where: { id: 'num-b', workspaceId: 'ws-a' },
      data: { agentId: 'agent-a' },
    });
    expect(blocked.count).toBe(0);
    expect(prisma.rowsOf('twilioPhoneNumber').find((r) => r['id'] === 'num-b')?.['agentId']).toBeNull();

    const removed = await numbers.deleteMany({ where: { id: 'num-b', workspaceId: 'ws-a' } });
    expect(removed.count).toBe(0);
    expect(prisma.rowsOf('twilioPhoneNumber')).toHaveLength(2);
  });

  it('records every call with the where it was given', async () => {
    const prisma = createFakePrisma({ agent: [{ id: 'agent-a', workspaceId: 'ws-a' }] });
    await (prisma['agent'] as { findFirst: (a: unknown) => Promise<unknown> }).findFirst({
      where: { id: 'agent-a', workspaceId: 'ws-a' },
    });
    expect(prisma.calls).toEqual([
      { model: 'agent', operation: 'findFirst', where: { id: 'agent-a', workspaceId: 'ws-a' } },
    ]);
  });
});
