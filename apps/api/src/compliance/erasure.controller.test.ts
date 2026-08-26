import { describe, expect, it, vi } from 'vitest';
import { ErasureController } from './erasure.controller';
import { ForbiddenError, UnauthorizedError } from '../common/errors';
import type { SessionUser } from '@voiceforge/shared';

function serviceStub() {
  return {
    eraseContact: vi.fn(async () => ({ success: true, erasedAt: 'now' })),
    eraseOrganization: vi.fn(async () => ({ success: true })),
    eraseUser: vi.fn(async () => ({ success: true })),
  };
}

const CALLER: SessionUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'caller@example.com',
  name: null,
  active_workspace_id: '22222222-2222-4222-8222-222222222222',
  active_workspace_name: 'Own Workspace',
  active_workspace_role: 'owner',
};

describe('ErasureController.eraseContact', () => {
  /**
   * The route previously accepted the tenant as a path param under
   * `WorkspaceGuard`, which no-ops without a `:workspaceId`. This asserts the
   * erasure is scoped to the session's workspace so a caller cannot name
   * another tenant.
   */
  it('erases only within the workspace the session resolves to', async () => {
    const erasure = serviceStub();
    const controller = new ErasureController(erasure as never);

    await controller.eraseContact(CALLER, 'contact-1');

    expect(erasure.eraseContact).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      'contact-1',
    );
  });

  it('refuses a session with no active workspace rather than guessing a tenant', async () => {
    const erasure = serviceStub();
    const controller = new ErasureController(erasure as never);

    await expect(
      controller.eraseContact({ ...CALLER, active_workspace_id: null }, 'contact-1'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(erasure.eraseContact).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const erasure = serviceStub();
    const controller = new ErasureController(erasure as never);

    await expect(controller.eraseContact(undefined, 'contact-1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(erasure.eraseContact).not.toHaveBeenCalled();
  });
});

describe('ErasureController.eraseUser', () => {
  it('deletes the session user, never a caller-supplied id', async () => {
    const erasure = serviceStub();
    const controller = new ErasureController(erasure as never);

    await controller.eraseUser(CALLER);

    expect(erasure.eraseUser).toHaveBeenCalledWith(CALLER.id);
  });

  it('refuses an unauthenticated caller instead of dereferencing undefined', async () => {
    const erasure = serviceStub();
    const controller = new ErasureController(erasure as never);

    await expect(controller.eraseUser(undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(erasure.eraseUser).not.toHaveBeenCalled();
  });
});
