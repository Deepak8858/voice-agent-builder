/**
 * Session and workspace-list cache keys, shared by the code that writes the
 * entries (SupabaseAuthService, WorkspacesService) and the code that revokes
 * them (CacheInvalidator). A second spelling of any of these is how an
 * invalidator silently stops matching. This module must stay a leaf (no
 * imports): SupabaseAuthService needs these keys but cannot import
 * CacheInvalidator, whose graph reaches back into it via WorkspaceGuard.
 * `workspace:access:*` and `org:access:*` stay with the guards that write
 * them, which export their own key helpers.
 */
export function sessionUserCacheKey(supabaseUserId: string): string {
  return `session:user:${supabaseUserId}`;
}

export function sessionWorkspaceCacheKey(appUserId: string): string {
  return `session:workspace:${appUserId}`;
}

export function sessionClaimsCacheKey(tokenHash: string): string {
  return `session:claims:${tokenHash}`;
}

export function workspaceListCacheKey(userId: string): string {
  return `workspaces:user:${userId}`;
}
