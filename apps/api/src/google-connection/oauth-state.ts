import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * CSRF protection for the OAuth authorization-code flow.
 *
 * The `state` value is `workspaceId.expiresAtMs.nonce.signature` where the
 * signature is an HMAC-SHA256 over the first three segments. The workspace id
 * is kept visible so the browser callback route can find its way back to the
 * right API endpoint, while the signature guarantees the value was minted by
 * us for that workspace and has not been swapped or replayed after expiry.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(workspaceId: string, secret: string): string {
  const expiresAt = Date.now() + STATE_TTL_MS;
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${workspaceId}.${expiresAt}.${nonce}`;
  return `${payload}.${signPayload(payload, secret)}`;
}

export function verifyOAuthState(
  state: string,
  expectedWorkspaceId: string,
  secret: string,
): boolean {
  const segments = state.split('.');
  if (segments.length !== 4) return false;
  const [workspaceId, expiresAtRaw, nonce, signature] = segments as [
    string,
    string,
    string,
    string,
  ];
  if (workspaceId !== expectedWorkspaceId) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = signPayload(`${workspaceId}.${expiresAtRaw}.${nonce}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}
