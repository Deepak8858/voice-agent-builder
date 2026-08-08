import { describe, expect, it } from 'vitest';
import { buildApiContextHeaders } from './api-context-headers';

describe('buildApiContextHeaders', () => {
  it('forwards the bearer token when a Supabase session access token exists', () => {
    const headers = buildApiContextHeaders('session-token', {
      internalApiKey: 'internal-key',
      contentType: 'application/json',
      requestedWith: 'XMLHttpRequest',
    });

    expect(headers).toEqual({
      authorization: 'Bearer session-token',
      'content-type': 'application/json',
      'x-internal-key': 'internal-key',
      'x-requested-with': 'XMLHttpRequest',
    });
  });

  it('omits the authorization header when no access token exists', () => {
    expect(buildApiContextHeaders(null)).not.toHaveProperty('authorization');
    expect(buildApiContextHeaders(undefined)).not.toHaveProperty('authorization');
    expect(buildApiContextHeaders('')).not.toHaveProperty('authorization');
  });

  it('always sends the internal key header, defaulting to an empty string', () => {
    expect(buildApiContextHeaders('token')['x-internal-key']).toBe('');
    expect(buildApiContextHeaders('token', { internalApiKey: 'key' })['x-internal-key']).toBe('key');
  });

  it('omits optional headers unless they are provided', () => {
    const headers = buildApiContextHeaders('token');

    expect(headers).toEqual({
      authorization: 'Bearer token',
      'x-internal-key': '',
    });
    expect(buildApiContextHeaders('token', { contentType: null })).not.toHaveProperty(
      'content-type',
    );
  });
});
