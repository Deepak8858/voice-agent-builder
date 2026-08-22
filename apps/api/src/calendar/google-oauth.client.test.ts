import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleOAuthClient,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_REAUTH_DETAILS_KEY,
} from './google-oauth.client';

const envMock = vi.hoisted(() => ({
  env: {
    GOOGLE_CLIENT_ID: 'client-id-123' as string | undefined,
    GOOGLE_CLIENT_SECRET: 'client-secret-456' as string | undefined,
  },
}));

vi.mock('../config/env', () => ({
  env: envMock.env,
  isProduction: () => false,
}));

function makeFetchSpy(response: Response | (() => never)) {
  const spy = vi.fn(async (_url: string, _init: RequestInit) => {
    if (typeof response === 'function') response();
    return response as Response;
  });
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return spy;
}

describe('GoogleOAuthClient.refreshAccessToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.env.GOOGLE_CLIENT_ID = 'client-id-123';
    envMock.env.GOOGLE_CLIENT_SECRET = 'client-secret-456';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exchanges the refresh token and converts expires_in into an absolute expiry', async () => {
    const fetchSpy = makeFetchSpy(
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3599 }), {
        status: 200,
      }),
    );

    const before = Date.now();
    const result = await new GoogleOAuthClient().refreshAccessToken('stored-refresh');

    expect(result.accessToken).toBe('fresh-access');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3599 * 1000);

    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error('token endpoint was not called');
    expect(call[0]).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(call[1].method).toBe('POST');

    const body = new URLSearchParams(call[1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-refresh');
    expect(body.get('client_id')).toBe('client-id-123');
  });

  it('returns a rotated refresh token when Google supplies one', async () => {
    makeFetchSpy(
      new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          expires_in: 3600,
          refresh_token: 'rotated-refresh',
        }),
        { status: 200 },
      ),
    );

    const result = await new GoogleOAuthClient().refreshAccessToken('stored-refresh');
    expect(result.refreshToken).toBe('rotated-refresh');
  });

  it('defaults to a one hour expiry when expires_in is absent or invalid', async () => {
    makeFetchSpy(
      new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 'soon' }), {
        status: 200,
      }),
    );

    const before = Date.now();
    const result = await new GoogleOAuthClient().refreshAccessToken('stored-refresh');
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('fails without calling Google when client credentials are not configured', async () => {
    const fetchSpy = makeFetchSpy(new Response('{}', { status: 200 }));
    envMock.env.GOOGLE_CLIENT_SECRET = undefined;

    await expect(
      new GoogleOAuthClient().refreshAccessToken('stored-refresh'),
    ).rejects.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: expect.stringContaining('not configured'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a re-connect error when Google rejects the refresh token', async () => {
    makeFetchSpy(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));

    await expect(
      new GoogleOAuthClient().refreshAccessToken('revoked-refresh'),
    ).rejects.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: expect.stringContaining('re-connect required'),
      details: { [GOOGLE_REAUTH_DETAILS_KEY]: true },
    });
  });

  it('does not flag a transient Google outage as a reauth condition', async () => {
    makeFetchSpy(
      new Response(JSON.stringify({ error: 'internal_failure' }), { status: 500 }),
    );

    const rejection = expect(new GoogleOAuthClient().refreshAccessToken('stored-refresh')).rejects;
    await rejection.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: expect.stringContaining('try again shortly'),
    });
  });

  it('does not flag a rate-limited refresh as a reauth condition', async () => {
    makeFetchSpy(new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), { status: 429 }));

    let thrown: unknown;
    try {
      await new GoogleOAuthClient().refreshAccessToken('stored-refresh');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { details?: Record<string, unknown> }).details?.[GOOGLE_REAUTH_DETAILS_KEY]).toBeUndefined();
  });

  it('surfaces an error when the network request throws', async () => {
    makeFetchSpy(() => {
      throw new Error('ECONNRESET');
    });

    await expect(
      new GoogleOAuthClient().refreshAccessToken('stored-refresh'),
    ).rejects.toMatchObject({ errorCode: 'CRM_NOT_CONFIGURED' });
  });

  it('rejects a malformed token response instead of returning an empty token', async () => {
    makeFetchSpy(new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }));

    await expect(
      new GoogleOAuthClient().refreshAccessToken('stored-refresh'),
    ).rejects.toMatchObject({
      errorCode: 'CRM_NOT_CONFIGURED',
      message: expect.stringContaining('malformed'),
    });
  });

  it('does not include the client secret in the thrown error message', async () => {
    makeFetchSpy(new Response('client-secret-456 was rejected', { status: 401 }));

    await expect(new GoogleOAuthClient().refreshAccessToken('stored-refresh')).rejects.toThrow(
      expect.not.stringContaining('client-secret-456') as unknown as string,
    );
  });
});
