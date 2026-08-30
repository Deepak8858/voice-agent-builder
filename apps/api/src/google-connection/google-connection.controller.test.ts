import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { SessionUser } from '@voiceforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import { RoleGuard } from '../common/role.guard';
import { WorkspaceGuard } from '../common/workspace.guard';
import { GoogleConnectionController } from './google-connection.controller';

const handler = (name: string) =>
  (GoogleConnectionController.prototype as unknown as Record<string, (...args: never[]) => unknown>)[
    name
  ];

function makeController() {
  const google = {
    getAuthorizeUrl: vi.fn(() => ({ url: 'https://accounts.google.test', state: 'state-1' })),
    completeOAuthCallback: vi.fn(async () => ({
      connected: true,
      status: 'connected',
      scopes: [],
    })),
    getStatus: vi.fn(async () => ({ connected: false, status: null, scopes: [] })),
    disconnect: vi.fn(async () => undefined),
  };
  return { google, controller: new GoogleConnectionController(google as never) };
}

/**
 * Exercises RoleGuard against the REAL @RequiredRole metadata on the named
 * handler (real Reflector, real class), so these tests fail if someone removes
 * a decorator or narrows the deliberate editor tier (it mirrors the write RLS
 * policy on google_oauth_connections). The membership role comes from the
 * stubbed database row, exactly where the guard is required to read it from.
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
    getClass: () => GoogleConnectionController,
  };
  return { guard: new RoleGuard(prisma as never, cache as never, new Reflector()), ctx };
}

function user(role: SessionUser['active_workspace_role']): SessionUser {
  return { id: 'user-1', active_workspace_role: role, active_workspace_id: 'ws-1' } as SessionUser;
}

const callbackDto = { code: 'auth-code', state: 'signed-state' };

const MANAGE_ROUTES = ['authorize', 'callbackGet', 'callbackPost', 'disconnect'] as const;

describe('GoogleConnectionController authorization', () => {
  it.each(MANAGE_ROUTES)('gates %s to owner/admin/editor', (name) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler(name))).toEqual({
      roles: ['owner', 'admin', 'editor'],
      fresh: false,
    });
  });

  it('leaves status open to every member', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('status')) ?? []).not.toContain(RoleGuard);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler('status'))).toBeUndefined();
  });

  it.each(MANAGE_ROUTES)('denies a viewer on %s', async (name) => {
    const { guard, ctx } = roleGuard(name, 'viewer');

    await expect(guard.canActivate(ctx as never)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each(['owner', 'admin', 'editor'] as const)('allows %s to start the connect flow', async (role) => {
    const { guard, ctx } = roleGuard('authorize', role);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  /**
   * Reads the guard list off the class and method the way Nest composes them
   * and runs the request through it: drop RoleGuard from the decorator and the
   * handler gets reached, which is the regression to catch.
   */
  it('disconnect cannot be reached as a viewer through the bound guards', async () => {
    const { controller, google } = makeController();
    const bound = [
      ...((Reflect.getMetadata(GUARDS_METADATA, GoogleConnectionController) ?? []) as unknown[]),
      ...((Reflect.getMetadata(GUARDS_METADATA, handler('disconnect')) ?? []) as unknown[]),
    ];

    expect(bound).toEqual([InternalAuthGuard, WorkspaceGuard, RoleGuard]);

    const { guard, ctx } = roleGuard('disconnect', 'viewer');
    const request = async () => {
      for (const Bound of bound) {
        const instance = Bound === RoleGuard ? guard : { canActivate: async () => true };
        if (!(await instance.canActivate(ctx as never))) {
          throw new ForbiddenError('guard returned false');
        }
      }
      return controller.disconnect('ws-1', user('viewer'));
    };

    await expect(request()).rejects.toBeInstanceOf(ForbiddenError);
    expect(google.disconnect).not.toHaveBeenCalled();
  });

  /**
   * RoleGuard has already proven a session exists on this path, but the
   * handler still needs the actor id for the audit trail — a missing user is
   * a misconfiguration (guard bypassed), and it must deny, not write
   * `actorUserId: undefined`.
   */
  it.each([
    ['disconnect', (c: GoogleConnectionController) => c.disconnect('ws-1', undefined)],
    ['POST callback', (c: GoogleConnectionController) =>
      c.callbackPost('ws-1', undefined, callbackDto)],
    ['GET callback', (c: GoogleConnectionController) =>
      c.callbackGet('ws-1', undefined, callbackDto)],
  ])('denies %s with no session user', async (_name, invoke) => {
    const { controller, google } = makeController();

    await expect(async () => invoke(controller)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(google.completeOAuthCallback).not.toHaveBeenCalled();
    expect(google.disconnect).not.toHaveBeenCalled();
  });

  it('passes the acting user to the callback for auditing', async () => {
    const { controller, google } = makeController();

    await controller.callbackPost('ws-1', user('editor'), callbackDto);

    expect(google.completeOAuthCallback).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      code: 'auth-code',
      state: 'signed-state',
      actorUserId: 'user-1',
    });
  });

  it('passes the acting user to disconnect for auditing', async () => {
    const { controller, google } = makeController();

    await expect(controller.disconnect('ws-1', user('owner'))).resolves.toEqual({
      success: true,
    });
    expect(google.disconnect).toHaveBeenCalledWith('ws-1', 'user-1');
  });

  it('keeps connection status readable without a role check', async () => {
    const { controller, google } = makeController();

    await expect(controller.status('ws-1')).resolves.toEqual({
      connected: false,
      status: null,
      scopes: [],
    });
    expect(google.getStatus).toHaveBeenCalledWith('ws-1');
  });
});
