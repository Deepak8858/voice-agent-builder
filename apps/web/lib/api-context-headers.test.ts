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
});
