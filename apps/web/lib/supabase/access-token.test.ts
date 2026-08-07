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

  it('reassembles chunked auth cookies in index order even when they arrive shuffled', () => {
    const session = encodeSession({ access_token: 'chunked-session-token' });
    const half = Math.ceil(session.length / 2);
    const first = session.slice(0, half);
    const second = session.slice(half);

    const token = extractSupabaseAccessToken(
      [
        { name: 'sb-nsgshzxxhytjmiiasobc-auth-token.1', value: second },
        { name: 'sb-nsgshzxxhytjmiiasobc-auth-token.0', value: first },
      ],
      'https://nsgshzxxhytjmiiasobc.supabase.co',
    );

    expect(token).toBe('chunked-session-token');
  });

  it('reads plain JSON cookie values without the base64- prefix', () => {
    const token = extractSupabaseAccessToken(
      [
        {
          name: 'sb-nsgshzxxhytjmiiasobc-auth-token',
          value: JSON.stringify({ access_token: 'plain-token' }),
        },
      ],
      'https://nsgshzxxhytjmiiasobc.supabase.co',
    );

    expect(token).toBe('plain-token');
  });

  it('refuses auth cookies belonging to a different Supabase project', () => {
    const token = extractSupabaseAccessToken(
      [
        {
          name: 'sb-otherproject-auth-token',
          value: encodeSession({ access_token: 'foreign-token' }),
        },
      ],
      'https://nsgshzxxhytjmiiasobc.supabase.co',
    );

    expect(token).toBeNull();
  });

  it('returns null when the Supabase URL is missing or invalid', () => {
    const cookies = [
      {
        name: 'sb-nsgshzxxhytjmiiasobc-auth-token',
        value: encodeSession({ access_token: 'session-token' }),
      },
    ];

    expect(extractSupabaseAccessToken(cookies, undefined)).toBeNull();
    expect(extractSupabaseAccessToken(cookies, 'not a url')).toBeNull();
  });

  it('returns null for malformed or token-less session payloads', () => {
    const url = 'https://nsgshzxxhytjmiiasobc.supabase.co';
    const name = 'sb-nsgshzxxhytjmiiasobc-auth-token';

    expect(extractSupabaseAccessToken([{ name, value: 'base64-not-json!!!' }], url)).toBeNull();
    expect(
      extractSupabaseAccessToken([{ name, value: encodeSession({ refresh_token: 'r' }) }], url),
    ).toBeNull();
    expect(
      extractSupabaseAccessToken([{ name, value: encodeSession({ access_token: 42 }) }], url),
    ).toBeNull();
    expect(
      extractSupabaseAccessToken([{ name, value: encodeSession({ access_token: '' }) }], url),
    ).toBeNull();
  });
});
