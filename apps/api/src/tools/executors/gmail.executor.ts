import { Injectable, Logger } from '@nestjs/common';
import { GmailSendMessageInputSchema } from '@voiceforge/shared';
import { safeFetch } from '../../common/safe-fetch';
import { fetchWithRetry } from '../../common/retry';
import {
  GOOGLE_REAUTH_REQUIRED_MESSAGE,
  GoogleConnectionService,
} from '../../google-connection/google-connection.service';
import { redactGoogleSecrets } from './google-error-redaction';
import type { ToolExecutor, ToolCallResult, ToolExecutionContext } from '../tools.service';

const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/**
 * Sends email through the workspace's unified Google connection. The access
 * token is resolved at call time from GoogleConnectionService — never from
 * tool config, which stores no secrets.
 */
@Injectable()
export class GmailExecutor implements ToolExecutor {
  readonly name = 'gmail';
  private readonly logger = new Logger(GmailExecutor.name);

  constructor(private readonly googleConnection: GoogleConnectionService) {}

  async execute(
    params: Record<string, unknown>,
    _config: Record<string, string>,
    context?: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!context?.workspaceId) {
      return { success: false, error: 'Gmail tool requires a workspace-scoped invocation.' };
    }

    const parsed = GmailSendMessageInputSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: 'to, subject, and body are required to send an email.' };
    }

    let accessToken: string;
    try {
      accessToken = await this.googleConnection.getUsableAccessToken(context.workspaceId);
    } catch (err) {
      return { success: false, error: reauthOrGenericError(err) };
    }

    const raw = buildRawMessage(parsed.data.to, parsed.data.subject, parsed.data.body);

    let response: Response;
    try {
      response = await fetchWithRetry(() =>
        safeFetch(GMAIL_SEND_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw }),
        }),
      );
    } catch (err) {
      this.logger.error(`Gmail send request failed: ${(err as Error).message}`);
      return { success: false, error: 'Gmail request failed — please try again shortly.' };
    }

    if (response.status === 401) {
      return { success: false, error: GOOGLE_REAUTH_REQUIRED_MESSAGE };
    }
    if (!response.ok) {
      this.logger.error(`Gmail API error: ${response.status}`);
      const detail = redactGoogleSecrets(await response.text().catch(() => ''));
      return {
        success: false,
        error: `Gmail API returned ${response.status}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as { id?: string };
    return { success: true, result: { message_id: data.id ?? null, to: parsed.data.to } };
  }
}

/** RFC 2822 message, base64url-encoded as the Gmail API requires. */
function buildRawMessage(to: string, subject: string, body: string): string {
  const message = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

/** Encode non-ASCII subjects per RFC 2047 so they survive transport. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function reauthOrGenericError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(GOOGLE_REAUTH_REQUIRED_MESSAGE) || message.includes('re-connect required')) {
    return GOOGLE_REAUTH_REQUIRED_MESSAGE;
  }
  return redactGoogleSecrets(message);
}
