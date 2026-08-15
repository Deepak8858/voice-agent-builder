import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';
import { CallNotFoundError } from '../common/errors';

/**
 * `Call.id` is a `@db.Uuid` column, so an id that is not a UUID makes Prisma
 * throw instead of returning no rows. The service must guard the id before the
 * lookup so a bad id is a clean 404, never a 500.
 */
describe('CallsService id guard', () => {
  function makeService(findFirst: ReturnType<typeof vi.fn>) {
    const prisma = { call: { findFirst } };
    return new CallsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('get() throws CallNotFoundError for a non-UUID id without querying', async () => {
    const findFirst = vi.fn();
    const service = makeService(findFirst);

    await expect(service.get('ws-1', 'not-a-uuid')).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('getLiveEvents() returns no backfill for a non-UUID id without querying', async () => {
    const findFirst = vi.fn();
    const service = makeService(findFirst);

    await expect(service.getLiveEvents('not-a-uuid', 'ws-1')).resolves.toEqual([]);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
