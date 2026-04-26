import { z } from 'zod';

export const ToolTypeSchema = z.enum(['webhook', 'http_get', 'http_post', 'google_calendar']);
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

const JsonSchemaShape = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.any()),
    required: z.array(z.string()).default([]),
  })
  .passthrough();

export const CreateToolDtoSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/, {
    message: 'name must be snake_case (a–z, 0–9, _ only).',
  }),
  description: z.string().min(1).max(500),
  tool_type: ToolTypeSchema,
  agent_id: z.string().uuid().nullable().optional(),
  config: WebhookConfigSchema,
  input_schema: JsonSchemaShape,
  enabled: z.boolean().default(true),
});
export type CreateToolDto = z.infer<typeof CreateToolDtoSchema>;

export const UpdateToolDtoSchema = CreateToolDtoSchema.partial();
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

export const ToolDetailSchema = ToolSummarySchema.extend({
  config: WebhookConfigSchema.omit({ hmac_secret: true }).extend({
    hmac_secret_set: z.boolean(),
  }),
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
