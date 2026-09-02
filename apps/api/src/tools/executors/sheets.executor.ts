import { Injectable, Logger } from '@nestjs/common';
import { SheetsAppendRowInputSchema } from '@voiceforge/shared';
import { safeFetch } from '../../common/safe-fetch';
import {
  GOOGLE_REAUTH_REQUIRED_MESSAGE,
  GoogleConnectionService,
} from '../../google-connection/google-connection.service';
import { redactGoogleSecrets } from './google-error-redaction';
import type { ToolExecutor, ToolCallResult, ToolExecutionContext } from '../tools.service';

/**
 * Appends rows through the workspace's unified Google connection. The access
 * token is resolved at call time from GoogleConnectionService — never from
 * tool config, which stores the target spreadsheet/sheet only.
 */
@Injectable()
export class SheetsExecutor implements ToolExecutor {
  readonly name = 'google_sheets';
  private readonly logger = new Logger(SheetsExecutor.name);

  constructor(private readonly googleConnection: GoogleConnectionService) {}

  async execute(
    params: Record<string, unknown>,
    config: Record<string, string>,
    context?: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    if (!context?.workspaceId) {
      return { success: false, error: 'Sheets tool requires a workspace-scoped invocation.' };
    }

    const parsed = SheetsAppendRowInputSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: 'values (a non-empty array) is required to append a row.' };
    }

    // The business configures the target on the tool. A model-supplied id is
    // only a fallback for a tool that was never configured: a model cannot know
    // a spreadsheet id and, invited to supply one, invents a name.
    const spreadsheetId = config.spreadsheet_id || parsed.data.spreadsheet_id;
    if (!spreadsheetId) {
      return {
        success: false,
        error: 'No spreadsheet configured. Set spreadsheet_id on the tool or pass it as a parameter.',
      };
    }
    const sheetName = config.sheet_name || parsed.data.sheet_name || 'Sheet1';

    let accessToken: string;
    try {
      accessToken = await this.googleConnection.getUsableAccessToken(context.workspaceId);
    } catch (err) {
      return { success: false, error: reauthOrGenericError(err) };
    }

    const range = encodeURIComponent(`${sheetName}!A1`);
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
      `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    // No retries: append is not idempotent — a timed-out request may still
    // have landed, and retrying would write duplicate rows.
    let response: Response;
    try {
      response = await safeFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [parsed.data.values] }),
      });
    } catch (err) {
      this.logger.error(`Sheets append request failed: ${(err as Error).message}`);
      return { success: false, error: 'Google Sheets request failed — please try again shortly.' };
    }

    if (response.status === 401) {
      return { success: false, error: GOOGLE_REAUTH_REQUIRED_MESSAGE };
    }
    if (!response.ok) {
      this.logger.error(`Sheets API error: ${response.status}`);
      const detail = redactGoogleSecrets(await response.text().catch(() => ''));
      return {
        success: false,
        error: `Sheets API returned ${response.status}.${detail ? ` ${detail.slice(0, 300)}` : ''}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as {
      updates?: { updatedRange?: string; updatedRows?: number };
    };
    return {
      success: true,
      result: {
        updated_range: data.updates?.updatedRange ?? null,
        updated_rows: data.updates?.updatedRows ?? 1,
      },
    };
  }
}

function reauthOrGenericError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(GOOGLE_REAUTH_REQUIRED_MESSAGE) || message.includes('re-connect required')) {
    return GOOGLE_REAUTH_REQUIRED_MESSAGE;
  }
  return redactGoogleSecrets(message);
}
