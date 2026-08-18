import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';
import { CallNotFoundError } from '../common/errors';

/**
 * `Call.id` is a `@db.Uuid` column, so an id that is not a UUID makes Prisma
 * throw instead of returning no rows. The service must guard the id before the
 * lookup so a bad id is a clean 404, never a 500.
 */
describe('CallsService id guard', () => {
  /**
   * Both guards return before touching any collaborator, so only `prisma` needs
   * to be real. The instance is built without invoking the constructor: a
   * positional argument list would have to grow every time a dependency is
   * added to `CallsService`, which is unrelated to what these cases assert.
   */
  function makeService(findFirst: ReturnType<typeof vi.fn>): CallsService {
    const service = Object.create(CallsService.prototype) as CallsService;
    Object.defineProperty(service, 'prisma', {
      value: { call: { findFirst } },
      configurable: true,
    });
    return service;
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
