import { z } from 'zod';

export const ToolTypeSchema = z.enum([
  'webhook',
  'http_get',
  'http_post',
  'google_calendar',
  'gmail',
  'google_sheets',
  'crm',
]);
export type ToolType = z.infer<typeof ToolTypeSchema>;

export const ToolInvocationStatusSchema = z.enum(['pending', 'success', 'failed']);
export type ToolInvocationStatus = z.infer<typeof ToolInvocationStatusSchema>;

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const WebhookConfigSchema = z.object({
  url: z.string().url(),
  method: HttpMethodSchema.default('POST'),
  headers: z.record(z.string(), z.string()).optional(),
  hmac_secret: z.string().min(8).optional(),
  timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
});
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

const GoogleCalendarConfigSchema = z
  .object({
    // OAuth credentials live in GoogleOAuthConnection. Tool config identifies
    // only the target calendar.
    calendar_id: z.string().min(1).default('primary'),
  })
  .strict();
export type GoogleCalendarConfig = z.infer<typeof GoogleCalendarConfigSchema>;

/**
 * Gmail/Sheets tool configs identify the operation and target only. Tokens are
 * never stored here: executors resolve the workspace's unified Google OAuth
 * connection at call time.
 *
 * Both are `.strict()`: every field is optional/defaulted, so a permissive
 * object schema would otherwise match (and silently strip) configs intended
 * for other members of the ToolConfigSchema union (e.g. CRM configs).
 */
const GmailConfigSchema = z
  .object({
    operation: z.literal('send_message').default('send_message'),
  })
  .strict();
export type GmailConfig = z.infer<typeof GmailConfigSchema>;

const GoogleSheetsConfigSchema = z
  .object({
    operation: z.literal('append_row').default('append_row'),
    spreadsheet_id: z.string().min(1).optional(),
    sheet_name: z.string().min(1).default('Sheet1'),
  })
  .strict();
export type GoogleSheetsConfig = z.infer<typeof GoogleSheetsConfigSchema>;

/** Per-operation input (tool argument) schemas for the new Google tools. */
export const GmailSendMessageInputSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
});
export type GmailSendMessageInput = z.infer<typeof GmailSendMessageInputSchema>;

export const SheetsAppendRowInputSchema = z.object({
  values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).max(50),
  spreadsheet_id: z.string().min(1).optional(),
  sheet_name: z.string().min(1).optional(),
});
export type SheetsAppendRowInput = z.infer<typeof SheetsAppendRowInputSchema>;

const CrmProviderSchema = z.enum(['pipedrive', 'hubspot', 'salesforce', 'generic']);
const CrmConfigSchema = z.object({
  provider: CrmProviderSchema,
  api_key: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  object_type: z.string().min(1).default('contact'),
});
export type CrmConfig = z.infer<typeof CrmConfigSchema>;

const ToolConfigSchema = z.union([
  WebhookConfigSchema,
  GoogleCalendarConfigSchema,
  GmailConfigSchema,
  GoogleSheetsConfigSchema,
  CrmConfigSchema,
]);

const JsonSchemaShape = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()).default([]),
  })
  .passthrough();

const CreateToolBaseShape = {
  name: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, {
    message: 'name must be snake_case (a–z, 0–9, _ only).',
  }),
  description: z.string().min(1).max(500),
  agent_id: z.string().uuid().nullable().optional(),
  input_schema: JsonSchemaShape,
  enabled: z.boolean().default(true),
};

export const CreateToolDtoSchema = z.discriminatedUnion('tool_type', [
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('webhook'), config: WebhookConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('http_get'), config: WebhookConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('http_post'), config: WebhookConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('google_calendar'), config: GoogleCalendarConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('gmail'), config: GmailConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('google_sheets'), config: GoogleSheetsConfigSchema }),
  z.object({ ...CreateToolBaseShape, tool_type: z.literal('crm'), config: CrmConfigSchema }),
]);
export type CreateToolDto = z.infer<typeof CreateToolDtoSchema>;

export const UpdateToolDtoSchema = z.object({
  name: CreateToolBaseShape.name.optional(),
  description: CreateToolBaseShape.description.optional(),
  tool_type: ToolTypeSchema.optional(),
  agent_id: z.string().uuid().nullable().optional(),
  config: ToolConfigSchema.optional(),
  input_schema: JsonSchemaShape.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateToolDto = z.infer<typeof UpdateToolDtoSchema>;

export const ToolSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string(),
  tool_type: ToolTypeSchema,
  enabled: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

const PublicWebhookConfigSchema = WebhookConfigSchema.omit({ hmac_secret: true }).extend({
  hmac_secret_set: z.boolean(),
});

const PublicGoogleCalendarConfigSchema = GoogleCalendarConfigSchema;

const PublicCrmConfigSchema = CrmConfigSchema.omit({ api_key: true }).extend({
  api_key_set: z.boolean(),
});

export const ToolDetailSchema = ToolSummarySchema.extend({
  config: z.union([
    PublicWebhookConfigSchema,
    PublicGoogleCalendarConfigSchema,
    GmailConfigSchema,
    GoogleSheetsConfigSchema,
    PublicCrmConfigSchema,
  ]),
  input_schema: JsonSchemaShape,
});
export type ToolDetail = z.infer<typeof ToolDetailSchema>;

export const InvokeToolDtoSchema = z.object({
  arguments: z.record(z.string(), z.any()).default({}),
  call_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
});
export type InvokeToolDto = z.infer<typeof InvokeToolDtoSchema>;

export const ToolInvocationSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  tool_id: z.string().uuid(),
  agent_id: z.string().uuid().nullable(),
  call_id: z.string().uuid().nullable(),
  status: ToolInvocationStatusSchema,
  response_status: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  error_message: z.string().nullable(),
});
export type ToolInvocationSummary = z.infer<typeof ToolInvocationSummarySchema>;

export const ToolInvocationDetailSchema = ToolInvocationSummarySchema.extend({
  request_payload: z.record(z.string(), z.any()),
  response_body: z.unknown().nullable(),
});
export type ToolInvocationDetail = z.infer<typeof ToolInvocationDetailSchema>;

// ---------------------------------------------------------------------------
// Google Workspace connection (unified OAuth)
// ---------------------------------------------------------------------------

/**
 * The single scope set requested by the unified "Connect Google Workspace"
 * flow: Calendar booking, Gmail send, and Sheets append. Shared between the
 * API (consent URL, tool provisioning) and the web app (preset copy) so the
 * two can never drift.
 */
export const GOOGLE_WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
] as const;

/** Response of GET /workspaces/:id/google/authorize. */
export const GoogleAuthorizeResponseSchema = z.object({
  url: z.string().url(),
  state: z.string().min(1),
});
export type GoogleAuthorizeResponse = z.infer<typeof GoogleAuthorizeResponseSchema>;

/** Response of GET /status and POST /callback on the Google connection. */
export const GoogleConnectionStatusResponseSchema = z.object({
  connected: z.boolean(),
  status: z.string().nullable(),
  scopes: z.array(z.string()),
});
export type GoogleConnectionStatusResponse = z.infer<
  typeof GoogleConnectionStatusResponseSchema
>;

/** Response of DELETE /workspaces/:id/google/disconnect. */
export const GoogleDisconnectResponseSchema = z.object({
  success: z.boolean(),
});
export type GoogleDisconnectResponse = z.infer<typeof GoogleDisconnectResponseSchema>;
