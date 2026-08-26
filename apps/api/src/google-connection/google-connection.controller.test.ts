import type { Request } from 'express';
import type { SessionUser } from '@voiceforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { GoogleConnectionController } from './google-connection.controller';

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

function request(role: SessionUser['active_workspace_role']): Request {
  return {
    user: { id: 'user-1', active_workspace_role: role, active_workspace_id: 'ws-1' },
  } as unknown as Request;
}

/** A request the guard never populated, e.g. because it was bypassed. */
function requestWithoutSessionUser(): Request {
  return {} as unknown as Request;
}

const callbackDto = { code: 'auth-code', state: 'signed-state' };

describe('GoogleConnectionController authorization', () => {
  it.each([
    ['authorize', (c: GoogleConnectionController) => c.authorize('ws-1', request('viewer'))],
    ['GET callback', (c: GoogleConnectionController) =>
      c.callbackGet('ws-1', request('viewer'), callbackDto)],
    ['POST callback', (c: GoogleConnectionController) =>
      c.callbackPost('ws-1', request('viewer'), callbackDto)],
    ['disconnect', (c: GoogleConnectionController) => c.disconnect('ws-1', request('viewer'))],
  ])('denies viewers access to %s', async (_name, invoke) => {
    const { controller, google } = makeController();

    await expect(async () => invoke(controller)).rejects.toBeInstanceOf(ForbiddenError);
    expect(google.getAuthorizeUrl).not.toHaveBeenCalled();
    expect(google.completeOAuthCallback).not.toHaveBeenCalled();
    expect(google.disconnect).not.toHaveBeenCalled();
  });

  it.each([
    ['authorize', (c: GoogleConnectionController) =>
      c.authorize('ws-1', requestWithoutSessionUser())],
    ['disconnect', (c: GoogleConnectionController) =>
      c.disconnect('ws-1', requestWithoutSessionUser())],
  ])('denies %s to a request with no session user', async (_name, invoke) => {
    const { controller, google } = makeController();

    await expect(async () => invoke(controller)).rejects.toBeInstanceOf(ForbiddenError);
    expect(google.getAuthorizeUrl).not.toHaveBeenCalled();
    expect(google.disconnect).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin', 'editor'] as const)('allows %s to start the connect flow', (role) => {
    const { controller, google } = makeController();

    expect(controller.authorize('ws-1', request(role))).toEqual({
      url: 'https://accounts.google.test',
      state: 'state-1',
    });
    expect(google.getAuthorizeUrl).toHaveBeenCalledWith('ws-1');
  });

  it('passes the acting user to the callback for auditing', async () => {
    const { controller, google } = makeController();

    await controller.callbackPost('ws-1', request('editor'), callbackDto);

    expect(google.completeOAuthCallback).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      code: 'auth-code',
      state: 'signed-state',
      actorUserId: 'user-1',
    });
  });

  it('passes the acting user to disconnect for auditing', async () => {
    const { controller, google } = makeController();

    await expect(controller.disconnect('ws-1', request('owner'))).resolves.toEqual({
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
