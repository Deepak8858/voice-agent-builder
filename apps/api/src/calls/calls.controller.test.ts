import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { CallNotFoundError, ForbiddenError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { CallsController } from './calls.controller';
import { liveCallChannel } from './calls.service';

const handler = (name: string) =>
  (CallsController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[name];

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class), so these tests fail if someone removes
 * a decorator or widens a role set. The membership role comes from the stubbed
 * database row, exactly where the guard is required to read it from.
 */
function roleGuard(handlerName: string, membershipRole: string | null) {
  const prisma = {
    membership: {
      findUnique: vi.fn(async () => (membershipRole ? { role: membershipRole } : null)),
    },
  };
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => undefined) };
  const ctx = {
    switchToHttp: () => ({
      getRequest: () => ({ params: { workspaceId: 'ws-1' }, user: { id: 'user-1' } }),
    }),
    getHandler: () => handler(handlerName),
    getClass: () => CallsController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

describe('CallsController authorization', () => {
  it.each(['startTestSession', 'end'] as const)('gates %s to owner/admin/editor', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin', 'editor'],
      fresh: false,
    });
  });

  it('gates startOutbound to owner/admin with a fresh role read', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('startOutbound'))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('startOutbound'))).toEqual({
      roles: ['owner', 'admin'],
      fresh: true,
    });
  });

  it.each(['list', 'get', 'live'] as const)('leaves %s open to every member', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name)) ?? []).not.toContain(RoleGuard);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toBeUndefined();
  });

  it.each(['startTestSession', 'end'] as const)('denies a viewer on %s', async (name) => {
    const { guard, ctx } = roleGuard(name, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['startTestSession', 'end'] as const)('allows an editor on %s', async (name) => {
    const { guard, ctx } = roleGuard(name, 'editor');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it('denies an editor on startOutbound', async () => {
    const { guard, ctx } = roleGuard('startOutbound', 'editor');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('allows an admin on startOutbound', async () => {
    const { guard, ctx } = roleGuard('startOutbound', 'admin');

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('cannot be reached as an editor through the guards the controller binds', async () => {
    const startOutboundCall = vi.fn();
    const controller = new CallsController({ startOutboundCall } as never, {} as never);
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, CallsController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler('startOutbound')) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard('startOutbound', 'editor');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.startOutbound('ws-1', 'agent-1', { to_number: '+15550100' } as never, {
        id: 'user-1',
      } as never);
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(startOutboundCall).not.toHaveBeenCalled();
  });
});

describe('CallsController.live', () => {
  /**
   * `on` captures the 'close' listener so a client disconnect can be fired at a
   * chosen moment; the real Response emits it, nothing else in the handler does.
   */
  function makeResponse({ closed = false } = {}) {
    const listeners: Record<string, () => void> = {};
    return {
      // Node sets this once 'close' has fired. `true` here stands for a client
      // that disconnected while the handler was still awaiting the backfill,
      // i.e. before the 'close' listener existed.
      closed,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        listeners[event] = listener;
      }),
      emit: (event: string) => listeners[event]?.(),
    };
  }

  it('streams live call events through the injected cache service', async () => {
    const calls = {
      getLiveEvents: vi.fn(async () => [{ type: 'call.started', call_id: 'call-1' }]),
    };
    const cache = {
      subscribe: vi.fn(() =>
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      ),
    };
    const response = makeResponse();

    const controller = new CallsController(calls as never, cache as never);
    await controller.live('ws-1', 'call-1', response as never);

    // Pinned as a literal, not via `liveCallChannel`: the point of the assertion
    // is that this exact string is what the publisher in calls.service.ts writes
    // to. Both sides moving together to a channel nobody publishes on would
    // still pass a helper-to-helper comparison, and the stream would go dark.
    expect(cache.subscribe).toHaveBeenCalledWith('call:ws-1:call-1');
    expect(cache.subscribe).toHaveBeenCalledWith(liveCallChannel('ws-1', 'call-1'));
    expect(response.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({ type: 'call.started', call_id: 'call-1' })}\n\n`,
    );
    expect(response.end).toHaveBeenCalled();
  });

  /**
   * A-007/A-029: the workspace guard proves membership of the workspace in the
   * URL, not ownership of the call. `getLiveEvents` rejecting is the only thing
   * standing between a guessed call id and a live subscription to another
   * tenant's transcript, so no subscription may be attached when it throws — and
   * no header may be flushed either, or the 404 cannot be written.
   */
  it('never subscribes when the call is not in the workspace', async () => {
    const calls = {
      getLiveEvents: vi.fn(async () => {
        throw new CallNotFoundError('call-1');
      }),
    };
    const cache = { subscribe: vi.fn() };
    const response = makeResponse();

    const controller = new CallsController(calls as never, cache as never);

    await expect(controller.live('ws-1', 'call-1', response as never)).rejects.toBeInstanceOf(
      CallNotFoundError,
    );
    expect(cache.subscribe).not.toHaveBeenCalled();
    expect(response.flushHeaders).not.toHaveBeenCalled();
  });

  /**
   * The leak this pins: `read()` on a quiet call stays pending until the next
   * message, which for most closed streams is never. Only cancelling the reader
   * runs `subscribe()`'s cleanup, which unsubscribes and disconnects the Redis
   * connection it duplicated. A `closed` flag checked by the loop is never
   * reached and leaks one connection per disconnect.
   */
  it('releases the subscription when the client closes before any message', async () => {
    const cancelled = vi.fn();
    const calls = { getLiveEvents: vi.fn(async () => []) };
    const cache = {
      subscribe: vi.fn(() => new ReadableStream({ start() {}, cancel: cancelled })),
    };
    const response = makeResponse();

    const controller = new CallsController(calls as never, cache as never);
    const streaming = controller.live('ws-1', 'call-1', response as never);

    // Let the handler reach the pending `read()` before disconnecting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).not.toHaveBeenCalled();

    response.emit('close');

    await expect(streaming).resolves.toBeUndefined();
    expect(cancelled).toHaveBeenCalled();
    expect(response.end).toHaveBeenCalled();
  });

  /**
   * The window the 'close' listener cannot cover: the backfill query is awaited
   * before the listener is attached, and Node does not replay an already-emitted
   * 'close'. Subscribing anyway and cancelling afterwards would still cost a
   * Redis subscribe/unsubscribe round trip per aborted request, so the handler
   * must bail before flushing headers and never open the subscription at all.
   */
  it('never subscribes when the client closed during the backfill', async () => {
    const calls = { getLiveEvents: vi.fn(async () => []) };
    const cache = {
      subscribe: vi.fn(() => new ReadableStream({ start: (c) => c.close() })),
    };
    const response = makeResponse({ closed: true });

    const controller = new CallsController(calls as never, cache as never);
    await expect(controller.live('ws-1', 'call-1', response as never)).resolves.toBeUndefined();

    expect(cache.subscribe).not.toHaveBeenCalled();
    expect(response.flushHeaders).not.toHaveBeenCalled();
  });
});
