import { describe, expect, it, vi } from 'vitest';
import { CallsService } from './calls.service';
import { CallNotFoundError } from '../common/errors';

/**
 * Both lookups return before touching any collaborator other than `prisma`, so
 * only `prisma` needs to be real. The instance is built without invoking the
 * constructor: a positional argument list would have to grow every time a
 * dependency is added to `CallsService`, which is unrelated to what these cases
 * assert.
 */
function makeService(
  findFirst: ReturnType<typeof vi.fn>,
  callEventFindMany: ReturnType<typeof vi.fn> = vi.fn(async () => []),
): CallsService {
  const service = Object.create(CallsService.prototype) as CallsService;
  Object.defineProperty(service, 'prisma', {
    value: { call: { findFirst }, callEvent: { findMany: callEventFindMany } },
    configurable: true,
  });
  return service;
}

// `uuid`'s `validate` enforces the version and variant nibbles, so an all-ones
// id would be rejected as malformed before the workspace lookup ever runs.
const CALL_ID = '11111111-1111-4111-8111-111111111111';

/**
 * `Call.id` is a `@db.Uuid` column, so an id that is not a UUID makes Prisma
 * throw instead of returning no rows. The service must guard the id before the
 * lookup so a bad id is a clean 404, never a 500.
 */
describe('CallsService id guard', () => {
  it('get() throws CallNotFoundError for a non-UUID id without querying', async () => {
    const findFirst = vi.fn();
    const service = makeService(findFirst);

    await expect(service.get('ws-1', 'not-a-uuid')).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('getLiveEvents() throws CallNotFoundError for a non-UUID id without querying', async () => {
    const findFirst = vi.fn();
    const service = makeService(findFirst);

    await expect(service.getLiveEvents('not-a-uuid', 'ws-1')).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
});

/**
 * The SSE handler subscribes to the live channel only after this resolves, so
 * an unowned call has to throw here. Resolving to an empty backfill instead let
 * any member of any workspace attach a Redis subscription to another tenant's
 * call by guessing its id (A-007/A-029).
 */
describe('CallsService.getLiveEvents tenant scope', () => {
  it('throws for a call that belongs to another workspace', async () => {
    // The row exists, but not under this workspace id — which is exactly what a
    // `{ id, workspaceId }` lookup returns for a foreign call.
    const findFirst = vi.fn(async () => null);
    const callEventFindMany = vi.fn(async () => []);
    const service = makeService(findFirst, callEventFindMany);

    await expect(service.getLiveEvents(CALL_ID, 'ws-attacker')).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: CALL_ID, workspaceId: 'ws-attacker' },
    });
    expect(callEventFindMany).not.toHaveBeenCalled();
  });

  // Same `findFirst → null` path as the foreign call, pinned separately because
  // a "not found" that quietly became an empty stream is the regression.
  it('throws for a call id that does not exist at all', async () => {
    const service = makeService(vi.fn(async () => null));

    await expect(service.getLiveEvents(CALL_ID, 'ws-1')).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
  });

  it('returns backfill for a call the workspace owns', async () => {
    const findFirst = vi.fn(async () => ({ id: CALL_ID, workspaceId: 'ws-1' }));
    const callEventFindMany = vi.fn(async () => [
      {
        eventType: 'call.started',
        eventTime: new Date('2026-08-29T00:00:00.000Z'),
        payload: { a: 1 },
      },
    ]);
    const service = makeService(findFirst, callEventFindMany);

    await expect(service.getLiveEvents(CALL_ID, 'ws-1')).resolves.toEqual([
      {
        type: 'call.started',
        call_id: CALL_ID,
        event_time: '2026-08-29T00:00:00.000Z',
        data: { a: 1 },
      },
    ]);
  });
});
