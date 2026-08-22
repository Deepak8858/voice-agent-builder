import { env } from '../../config/env';

/**
 * Strip token material and the OAuth client secret from any error text that
 * could reach ToolInvocation.errorMessage, responseBody, or audit metadata.
 *
 * Google OAuth artifacts have recognizable shapes: access tokens start with
 * `ya29.`, refresh tokens with `1//`, and Authorization headers carry
 * `Bearer <token>`. The configured client secret is redacted by value.
 */
export function redactGoogleSecrets(text: string): string {
  if (!text) return text;
  let redacted = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/1\/\/[A-Za-z0-9._-]+/g, '[redacted]');
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (clientSecret) {
    redacted = redacted.split(clientSecret).join('[redacted]');
  }
  return redacted;
}
