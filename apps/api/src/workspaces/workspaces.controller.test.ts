import type { SessionUser } from '@voiceforge/shared';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { WorkspacesController } from './workspaces.controller';

function user(role: SessionUser['active_workspace_role']): SessionUser {
  return { id: 'user-1', active_workspace_id: 'ws-1', active_workspace_role: role } as SessionUser;
}

function makeController() {
  const service = { update: vi.fn(async () => ({ id: 'ws-1', name: 'New' })) };
  return { service, controller: new WorkspacesController(service as never) };
}

describe('WorkspacesController.update authorization', () => {
  it.each(['viewer', 'editor'] as const)('denies %s a rename', async (role) => {
    const { controller, service } = makeController();

    await expect(controller.update('ws-1', { name: 'Renamed' }, user(role)))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(service.update).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'] as const)('allows %s a rename', async (role) => {
    const { controller, service } = makeController();

    await controller.update('ws-1', { name: 'Renamed' }, user(role));

    expect(service.update).toHaveBeenCalledWith('ws-1', 'user-1', { name: 'Renamed' });
  });
});
