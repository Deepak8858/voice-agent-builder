import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { ErasureController } from './erasure.controller';
import { REQUIRED_ROLE_KEY } from '../common/decorators/required-role.decorator';
import { RoleGuard } from '../common/role.guard';
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

/**
 * CS-40: both self-service handlers carried a `v1/` that main.ts already sets as
 * the global prefix, so they served at `/api/v1/v1/...`. Asserted here because
 * the path is one half of a two-sided contract with the web proxy allow-list and
 * nothing else in this repo pins it — see proxy-guards.test.ts for the other
 * half, which pins that `/workspaces/me/contacts/.../erasure` is now proxyable
 * and `/users/me/erasure` still is not.
 */
describe('ErasureController route paths', () => {
  it('does not repeat the global api/v1 prefix', () => {
    expect(
      Reflect.getMetadata('path', ErasureController.prototype.eraseContact),
    ).toBe('workspaces/me/contacts/:contactId/erasure');
    expect(Reflect.getMetadata('path', ErasureController.prototype.eraseUser)).toBe(
      'users/me/erasure',
    );
    // The operator route never had the doubled prefix; pinned so a future edit
    // cannot "restore consistency" by adding one.
    expect(
      Reflect.getMetadata('path', ErasureController.prototype.eraseOrganization),
    ).toBe('admin/orgs/:orgId');
  });
});

describe('ErasureController.eraseContact authorization', () => {
  // Dropping the doubled prefix made this route browser-reachable, which made
  // the missing role gate live: erasure permanently destroys the contact and
  // its cascade, so a viewer must not trigger it. Pinned by metadata on the
  // real class — a guard built by hand in a test pins nothing.
  it('binds RoleGuard with a fresh owner/admin requirement', () => {
    const handler = ErasureController.prototype.eraseContact;

    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RoleGuard]);
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, handler)).toEqual({
      roles: ['owner', 'admin'],
      fresh: true,
    });
  });
});

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
