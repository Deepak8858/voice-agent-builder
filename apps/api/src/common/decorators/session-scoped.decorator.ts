import { SetMetadata } from '@nestjs/common';

export const IS_SESSION_SCOPED_KEY = 'isSessionScoped';

/**
 * Declares that a route takes its tenant from the authenticated session
 * (`active_workspace_id`) rather than from a path param.
 *
 * `WorkspaceGuard` refuses routes with no `:workspaceId` param, because
 * accepting them silently is what allowed org-scoped routes to appear guarded
 * while performing no tenant check. Routes that legitimately resolve their
 * tenant from the session opt out with this decorator, which makes the intent
 * explicit at the call site instead of relying on the guard's fallthrough.
 *
 * This is not an authorization bypass: the global `InternalAuthGuard` still
 * requires a verified Supabase token, and `active_workspace_id` is derived
 * server-side from a membership lookup, so the caller cannot choose it.
 */
export const SessionScoped = () => SetMetadata(IS_SESSION_SCOPED_KEY, true);
