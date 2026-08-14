import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';
import { UnauthorizedError } from '../common/errors';
import { TwilioProviderAdapter } from '../telephony/providers/twilio.provider';

export interface TwilioSignedRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Absolute request path including query string, exactly as Twilio called it. */
  originalUrl: string;
  /** Parsed form fields. Twilio signs the urlencoded parameters, not the raw bytes. */
  body: Record<string, unknown>;
}

/**
 * Verifies `X-Twilio-Signature` for the legacy voice webhooks.
 *
 * These endpoints are unauthenticated by necessity — Twilio cannot present a
 * session — so the signature is the only thing that distinguishes a real
 * provider callback from an internet stranger. Verification therefore has to
 * run before any database read, call creation, billing admission, or media
 * stream, and it fails closed on a missing token, a missing header, or a
 * mismatch.
 *
 * The signing token is the account-level `TWILIO_AUTH_TOKEN`: the legacy
 * `TwilioPhoneNumber` records carry no per-number provider connection, and it
 * is the same credential this adapter already uses to talk to Twilio.
 */
@Injectable()
export class TwilioSignatureVerifier {
  private readonly logger = new Logger(TwilioSignatureVerifier.name);

  constructor(private readonly adapter: TwilioProviderAdapter) {}

  async assertValidSignature(request: TwilioSignedRequest, eventType: string): Promise<void> {
    const authToken = env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      this.logger.error(
        `Rejected ${eventType} webhook: TWILIO_AUTH_TOKEN is not configured, so no delivery can be authenticated.`,
      );
      throw new UnauthorizedError('Twilio webhook signing token is not configured.');
    }

    if (!signatureHeader(request.headers)) {
      this.logger.warn(`Rejected unsigned ${eventType} webhook.`);
      throw new UnauthorizedError('Missing Twilio webhook signature.');
    }

    const valid = await this.adapter.validateWebhookSignature({
      secret: authToken,
      headers: request.headers,
      url: this.publicUrl(request.originalUrl),
      body: request.body,
    });

    if (!valid) {
      this.logger.warn(`Rejected ${eventType} webhook with an invalid Twilio signature.`);
      throw new UnauthorizedError('Invalid Twilio webhook signature.');
    }
  }

  /**
   * Rebuilds the exact public URL Twilio signed.
   *
   * The origin comes from configuration rather than the request's `Host`
   * header, which a caller controls and could otherwise use to forge a URL
   * that matches their own signature. `TWILIO_TWIML_WEBHOOK_URL` is preferred
   * because it is the origin this adapter registers with Twilio when it places
   * calls; the app base URL is the fallback for deployments that serve the
   * webhook from the primary origin.
   */
  private publicUrl(originalUrl: string): string {
    const base = env.TWILIO_TWIML_WEBHOOK_URL ?? env.APP_BASE_URL ?? env.WEB_BASE_URL;
    // With no configured origin, `new URL(path, undefined)` throws and Twilio
    // sees a 500 that says nothing about the cause. Refuse explicitly instead,
    // on the same terms as a missing signing token.
    if (!base) {
      this.logger.error(
        'Rejected Twilio webhook: no public origin is configured, so the signed URL cannot be rebuilt.',
      );
      throw new UnauthorizedError('Twilio webhook origin is not configured.');
    }
    return new URL(originalUrl, base).toString();
  }
}

function signatureHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers['x-twilio-signature'] ?? headers['X-Twilio-Signature'];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
