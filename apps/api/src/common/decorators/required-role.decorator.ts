import { SetMetadata } from '@nestjs/common';
import type { SessionUser } from '@voiceforge/shared';

export const REQUIRED_ROLE_KEY = 'requiredRole';

export type WorkspaceRole = SessionUser['active_workspace_role'];

export interface RequiredRoleOptions {
  /**
   * Skip the workspace-access cache and read the membership row directly.
   * Membership roles are cached for 300 seconds, so a just-demoted admin can
   * keep acting as one for up to five minutes on cached routes. Routes that
   * move money or destroy data cannot tolerate that window and must set this.
   */
  fresh?: boolean;
}

export interface RequiredRoleMetadata {
  roles: readonly WorkspaceRole[];
  fresh: boolean;
}

/**
 * Declares the workspace roles allowed to reach a route, enforced by
 * `RoleGuard`. This is an EXPLICIT ALLOW-LIST, not a hierarchy: the existing
 * hand-written checks use different sets (billing admits owner/admin, the
 * Google connection admits owner/admin/editor), and a "role X or above"
 * ranking would silently widen or narrow one of them. Name every role you
 * mean to admit.
 *
 * Membership is proven by WorkspaceGuard; this decorator only narrows WHICH
 * members get through, so it never replaces `@UseGuards(WorkspaceGuard)` —
 * bind RoleGuard after it: `@UseGuards(WorkspaceGuard, RoleGuard)`.
 */
export function RequiredRole(...roles: WorkspaceRole[]): MethodDecorator & ClassDecorator;
export function RequiredRole(
  roles: readonly WorkspaceRole[],
  options: RequiredRoleOptions,
): MethodDecorator & ClassDecorator;
export function RequiredRole(
  first: WorkspaceRole | readonly WorkspaceRole[],
  ...rest: (WorkspaceRole | RequiredRoleOptions)[]
): MethodDecorator & ClassDecorator {
  const meta: RequiredRoleMetadata = Array.isArray(first)
    ? {
        roles: first as readonly WorkspaceRole[],
        fresh: (rest[0] as RequiredRoleOptions | undefined)?.fresh === true,
      }
    : { roles: [first as WorkspaceRole, ...(rest as WorkspaceRole[])], fresh: false };
  return SetMetadata(REQUIRED_ROLE_KEY, meta);
}
