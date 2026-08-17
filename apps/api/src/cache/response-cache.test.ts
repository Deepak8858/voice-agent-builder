import { describe, expect, it, vi } from 'vitest';
import {
  buildResponseCacheKey,
  responseCacheVersionKey,
  ResponseCacheScopeError,
} from './response-cache.key';
import { ResponseCacheService } from './response-cache.service';
import type { CacheService } from './cache.service';

const SCOPE = { workspaceId: 'ws-1', userId: 'user-1' };

describe('buildResponseCacheKey', () => {
  it('scopes the key by workspace, user, and route', () => {
    expect(buildResponseCacheKey(SCOPE, 'agents')).toBe('resp:v1:ws:ws-1:user:user-1:agents');
  });

  it('appends variant and version segments', () => {
    expect(buildResponseCacheKey(SCOPE, 'agents', { variant: 'status=draft', version: 3 })).toBe(
      'resp:v1:ws:ws-1:user:user-1:agents:status=draft:v3',
    );
  });

  it('produces different keys for different workspaces', () => {
    const a = buildResponseCacheKey({ workspaceId: 'ws-a', userId: 'u' }, 'agents');
    const b = buildResponseCacheKey({ workspaceId: 'ws-b', userId: 'u' }, 'agents');
    expect(a).not.toBe(b);
  });

  it('produces different keys for different users in one workspace', () => {
    const a = buildResponseCacheKey({ workspaceId: 'ws', userId: 'u-a' }, 'agents');
    const b = buildResponseCacheKey({ workspaceId: 'ws', userId: 'u-b' }, 'agents');
    expect(a).not.toBe(b);
  });

  it.each([
    ['missing workspaceId', { workspaceId: undefined, userId: 'u' }],
    ['empty workspaceId', { workspaceId: '', userId: 'u' }],
    ['blank workspaceId', { workspaceId: '   ', userId: 'u' }],
    ['null workspaceId', { workspaceId: null, userId: 'u' }],
    ['missing userId', { workspaceId: 'ws', userId: undefined }],
    ['empty userId', { workspaceId: 'ws', userId: '' }],
    ['blank userId', { workspaceId: 'ws', userId: '  ' }],
    ['null userId', { workspaceId: 'ws', userId: null }],
  ])('rejects %s', (_label, scope) => {
    expect(() => buildResponseCacheKey(scope as unknown as typeof SCOPE, 'agents')).toThrow(
      ResponseCacheScopeError,
    );
  });

  it('rejects a missing scope object entirely', () => {
    expect(() => buildResponseCacheKey(undefined as unknown as typeof SCOPE, 'agents')).toThrow(
      ResponseCacheScopeError,
    );
  });

  it('rejects an empty route', () => {
    expect(() => buildResponseCacheKey(SCOPE, '')).toThrow(ResponseCacheScopeError);
  });

  it('rejects scope values containing the key separator', () => {
    expect(() => buildResponseCacheKey({ workspaceId: 'ws:1', userId: 'u' }, 'agents')).toThrow(
      ResponseCacheScopeError,
    );
    expect(() => buildResponseCacheKey({ workspaceId: 'ws', userId: 'u:2' }, 'agents')).toThrow(
      ResponseCacheScopeError,
    );
  });

  it('rejects a negative or fractional version', () => {
    expect(() => buildResponseCacheKey(SCOPE, 'agents', { version: -1 })).toThrow(
      ResponseCacheScopeError,
    );
    expect(() => buildResponseCacheKey(SCOPE, 'agents', { version: 1.5 })).toThrow(
      ResponseCacheScopeError,
    );
  });

  it('requires a workspace id for the version key', () => {
    expect(() => responseCacheVersionKey('')).toThrow(ResponseCacheScopeError);
    expect(responseCacheVersionKey('ws-1')).toBe('resp:v1:ver:ws:ws-1');
  });
});

function fakeCache() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    incr: vi.fn().mockResolvedValue(1),
    readThrough: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) =>
      loader(),
    ),
  };
}

describe('ResponseCacheService', () => {
  it('reads through using a scoped, versioned key', async () => {
    const cache = fakeCache();
    cache.get.mockResolvedValue(2);
    const service = new ResponseCacheService(cache as unknown as CacheService);

    const value = await service.readThrough(SCOPE, 'agents', 30, async () => 'fresh');

    expect(value).toBe('fresh');
    expect(cache.readThrough).toHaveBeenCalledWith(
      'resp:v1:ws:ws-1:user:user-1:agents:v2',
      30,
      expect.any(Function),
    );
  });

  it('treats an absent version counter as generation 0', async () => {
    const cache = fakeCache();
    const service = new ResponseCacheService(cache as unknown as CacheService);

    await service.readThrough(SCOPE, 'agents', 30, async () => 'fresh');

    expect(cache.readThrough).toHaveBeenCalledWith(
      'resp:v1:ws:ws-1:user:user-1:agents:v0',
      30,
      expect.any(Function),
    );
  });

  it('bypasses the cache entirely when the scope is invalid', async () => {
    const cache = fakeCache();
    const service = new ResponseCacheService(cache as unknown as CacheService);
    const loader = vi.fn().mockResolvedValue('fresh');

    const value = await service.readThrough(
      { workspaceId: '', userId: 'user-1' },
      'agents',
      30,
      loader,
    );

    expect(value).toBe('fresh');
    expect(loader).toHaveBeenCalledOnce();
    expect(cache.readThrough).not.toHaveBeenCalled();
  });

  it('invalidates a workspace by bumping its version counter', async () => {
    const cache = fakeCache();
    const service = new ResponseCacheService(cache as unknown as CacheService);

    await service.invalidateWorkspace('ws-1');

    expect(cache.incr).toHaveBeenCalledWith('resp:v1:ver:ws:ws-1');
  });

  it('does not throw when invalidation fails', async () => {
    const cache = fakeCache();
    cache.incr.mockRejectedValue(new Error('redis down'));
    const service = new ResponseCacheService(cache as unknown as CacheService);

    await expect(service.invalidateWorkspace('ws-1')).resolves.toBeUndefined();
  });

  it('serves a different cache generation after invalidation', async () => {
    const cache = fakeCache();
    cache.get.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const service = new ResponseCacheService(cache as unknown as CacheService);

    await service.readThrough(SCOPE, 'agents', 30, async () => 'a');
    await service.invalidateWorkspace('ws-1');
    await service.readThrough(SCOPE, 'agents', 30, async () => 'b');

    const keys = cache.readThrough.mock.calls.map((call) => call[0]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('writes a loaded value to the generation resolved before invalidation', async () => {
    const cache = fakeCache();
    cache.get.mockResolvedValueOnce(0).mockResolvedValueOnce(null);
    const service = new ResponseCacheService(cache as unknown as CacheService);

    const result = await service.readThroughWithStatus(SCOPE, 'agents', 30, async () => {
      await service.invalidateWorkspace('ws-1');
      return 'fresh';
    });

    expect(result).toStrictEqual({ value: 'fresh', fromCache: false });
    expect(cache.set).toHaveBeenCalledWith('resp:v1:ws:ws-1:user:user-1:agents:v0', 'fresh', 30);
  });
});
