interface CookieLike {
  name: string;
  value: string;
}

export function extractSupabaseAccessToken(
  cookies: CookieLike[],
  supabaseUrl: string | undefined,
): string | null {
  if (!supabaseUrl) return null;

  const projectRef = supabaseProjectRef(supabaseUrl);
  if (!projectRef) return null;

  const storageKey = `sb-${projectRef}-auth-token`;
  const raw = readCookieValue(cookies, storageKey);
  if (!raw) return null;

  const decoded = raw.startsWith('base64-')
    ? Buffer.from(raw.slice('base64-'.length), 'base64url').toString('utf8')
    : raw;

  try {
    const session = JSON.parse(decoded) as { access_token?: unknown };
    return typeof session.access_token === 'string' && session.access_token.length > 0
      ? session.access_token
      : null;
  } catch {
    return null;
  }
}

function supabaseProjectRef(supabaseUrl: string): string | null {
  try {
    return new URL(supabaseUrl).hostname.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

function readCookieValue(cookies: CookieLike[], storageKey: string): string | null {
  const direct = cookies.find((cookie) => cookie.name === storageKey);
  if (direct) return direct.value;

  const chunks = cookies
    .map((cookie) => {
      const match = cookie.name.match(new RegExp(`^${escapeRegExp(storageKey)}\\.(\\d+)$`));
      return match ? { index: Number(match[1]), value: cookie.value } : null;
    })
    .filter((chunk): chunk is { index: number; value: string } => chunk !== null)
    .sort((a, b) => a.index - b.index);

  return chunks.length > 0 ? chunks.map((chunk) => chunk.value).join('') : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
