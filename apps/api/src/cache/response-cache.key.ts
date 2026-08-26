/**
 * Key builder for cached hot read endpoints.
 *
 * Response caching is the one place where a key bug becomes a tenant data
 * leak: if two workspaces or two users can ever compute the same key, one
 * request's response is served to the other. So the scope is not optional and
 * not defaulted — a missing or blank `workspaceId`/`userId` throws instead of
 * silently producing a key like `ws::user::agents`, which every unscoped
 * caller would collide on.
 *
 * Format: `resp:v1:ws:{workspaceId}:user:{userId}:{route}[:{variant}][:v{n}]`
 */

export interface ResponseCacheScope {
  workspaceId: string;
  userId: string;
}

export class ResponseCacheScopeError extends Error {
  constructor(field: string) {
    super(`Response cache key requires a non-empty ${field}`);
    this.name = 'ResponseCacheScopeError';
  }
}

const PREFIX = 'resp:v1';

/** Characters that would let a caller forge a different key by injecting separators. */
const SEPARATOR = /[:\s]/;

function requireSegment(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ResponseCacheScopeError(field);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ResponseCacheScopeError(field);
  if (SEPARATOR.test(trimmed)) throw new ResponseCacheScopeError(field);
  return trimmed;
}

export interface ResponseCacheKeyOptions {
  /** Distinguishes query-dependent responses (filters, pagination). */
  variant?: string;
  /**
   * Workspace cache generation. Bumping the counter changes every key for
   * that workspace at once, so a mutation invalidates without SCANning or
   * enumerating routes, and stale entries simply expire on their own TTL.
   */
  version?: number;
}

/** Build a tenant- and user-scoped cache key. */
export function buildResponseCacheKey(
  scope: ResponseCacheScope,
  route: string,
  options: ResponseCacheKeyOptions = {},
): string {
  const workspaceId = requireSegment(scope?.workspaceId, 'workspaceId');
  const userId = requireSegment(scope?.userId, 'userId');
  const routeSegment = requireSegment(route, 'route');

  let key = `${PREFIX}:ws:${workspaceId}:user:${userId}:${routeSegment}`;
  if (options.variant !== undefined) {
    key += `:${requireSegment(options.variant, 'variant')}`;
  }
  if (options.version !== undefined) {
    if (!Number.isInteger(options.version) || options.version < 0) {
      throw new ResponseCacheScopeError('version');
    }
    key += `:v${options.version}`;
  }
  return key;
}

/** Key holding a workspace's cache generation counter. */
export function responseCacheVersionKey(workspaceId: string): string {
  return `${PREFIX}:ver:ws:${requireSegment(workspaceId, 'workspaceId')}`;
}
