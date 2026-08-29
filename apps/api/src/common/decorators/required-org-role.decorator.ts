import { SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from './required-role.decorator';

export const REQUIRED_ORG_ROLE_KEY = 'requiredOrgRole';

/**
 * Narrows an `OrganizationGuard` route from "any member of the organization" to
 * a seat allow-list, enforced by `OrganizationGuard` itself.
 *
 * This is deliberately NOT `@RequiredRole`, which is a different seat resolved
 * by a different guard. `RoleGuard` refuses outright on any route keyed by
 * `:orgId` (see FOREIGN_TENANT_PARAMS in role.guard.ts): it resolves WORKSPACE
 * memberships, and its `active_workspace_id` fallback would check the caller's
 * seat in their SESSION workspace while the handler acts on the organization
 * named in the path. So `@RequiredRole('owner', 'admin')` on an org route 403s
 * every caller including owners, and cannot express "org admin" at all. This
 * decorator can, because OrganizationGuard resolves the seat the same way it
 * resolves access: a membership in ANY workspace belonging to `:orgId` whose
 * role is listed here, or outright ownership of the organization — an org owner
 * holds the top administrative seat by definition, and is admitted even with no
 * membership row, or they would be locked out of their own org.
 *
 * Like `@RequiredRole` this is an EXPLICIT ALLOW-LIST, not a hierarchy: name
 * every role you mean to admit, so widening or narrowing a set is a visible diff.
 *
 * Absence of this decorator means "membership is enough", because
 * OrganizationGuard is bound to routes that legitimately need no seat. An empty
 * list, however, fails closed — that is a declaration that gates nothing.
 *
 * There is no `fresh` option: OrganizationGuard never serves a role-gated route
 * from the `org:access` cache, since that entry records a bare membership fact
 * with no role in it. Role decisions here are always read from the row.
 */
export const RequiredOrgRole = (...roles: WorkspaceRole[]) =>
  SetMetadata(REQUIRED_ORG_ROLE_KEY, roles);
