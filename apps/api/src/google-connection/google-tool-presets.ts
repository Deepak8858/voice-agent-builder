/**
 * The single scope set requested by the unified "Connect Google Workspace"
 * flow: Calendar booking, Gmail send, and Sheets append. One consent covers
 * every provisioned tool, so connecting is a genuine one-click experience.
 * The list itself lives in @voiceforge/shared so the web app's preset copy
 * can never drift from what the API actually requests.
 */
export { GOOGLE_WORKSPACE_SCOPES } from '@voiceforge/shared';

export interface GoogleToolPreset {
  name: string;
  toolType: 'google_calendar' | 'gmail' | 'google_sheets';
  description: string;
  /** Config identifies operation and target only — never tokens. */
  config: Record<string, string>;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /** Scope that must have been granted for this tool to be provisioned. */
  requiredScope: string;
}

/**
 * Workspace-wide tools provisioned automatically after a successful Google
 * OAuth callback (`agentId: null`, `enabled: true`). Their names, types, and
 * input schemas mirror the corresponding executors.
 */
export const GOOGLE_TOOL_PRESETS: GoogleToolPreset[] = [
  {
    name: 'book_calendar_event',
    toolType: 'google_calendar',
    description:
      'Book an appointment on the connected Google Calendar. Provide a summary plus ISO start and end datetimes.',
    config: { calendar_id: 'primary' },
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create_event', 'list_events', 'find_free_slot'],
          description: 'Calendar operation to perform.',
        },
        summary: { type: 'string', description: 'Event title.' },
        start_iso: { type: 'string', description: 'Event start as an ISO 8601 datetime.' },
        end_iso: { type: 'string', description: 'Event end as an ISO 8601 datetime.' },
        time_zone: { type: 'string', description: 'IANA time zone, defaults to UTC.' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attendee email addresses.',
        },
        description: { type: 'string', description: 'Optional event description.' },
        duration_minutes: {
          type: 'number',
          description: 'Slot length for find_free_slot, in minutes.',
        },
      },
      required: ['operation'],
    },
    requiredScope: 'https://www.googleapis.com/auth/calendar.events',
  },
  {
    name: 'send_gmail',
    toolType: 'gmail',
    description: 'Send an email from the connected Gmail account.',
    config: { operation: 'send_message' },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Plain-text email body.' },
      },
      required: ['to', 'subject', 'body'],
    },
    requiredScope: 'https://www.googleapis.com/auth/gmail.send',
  },
  {
    name: 'append_sheet_row',
    toolType: 'google_sheets',
    description:
      'Append a row of values to the connected Google Sheet. Use an empty string for a column the caller did not provide.',
    config: { operation: 'append_row', sheet_name: 'Sheet1' },
    // No spreadsheet_id / sheet_name parameters: the target is tool config the
    // business sets. Offered the choice, the model invents a spreadsheet name.
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { type: ['string', 'number', 'boolean', 'null'] },
          description: 'Cell values for the new row, in column order.',
        },
      },
      required: ['values'],
    },
    requiredScope: 'https://www.googleapis.com/auth/spreadsheets',
  },
];
