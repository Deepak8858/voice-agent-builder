import { describe, expect, it } from 'vitest';
import { extractSupabaseAccessToken } from './access-token';

function encodeSession(session: unknown): string {
  return `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;
}

describe('extractSupabaseAccessToken', () => {
  it('reads the access token from the Supabase SSR auth cookie', () => {
    const token = extractSupabaseAccessToken(
      [
        {
          name: 'sb-nsgshzxxhytjmiiasobc-auth-token',
          value: encodeSession({ access_token: 'session-token' }),
        },
      ],
      'https://nsgshzxxhytjmiiasobc.supabase.co',
    );

    expect(token).toBe('session-token');
  });
});
