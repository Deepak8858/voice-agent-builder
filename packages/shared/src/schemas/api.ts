import { z } from 'zod';

export const API_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'VALIDATION_ERROR',
  'WORKSPACE_NOT_FOUND',
  'AGENT_NOT_FOUND',
  'AGENT_SPEC_INVALID',
  'KNOWLEDGE_SOURCE_NOT_FOUND',
  'KNOWLEDGE_INGEST_FAILED',
  'KNOWLEDGE_FILE_INVALID',
  'CALL_NOT_FOUND',
  'AGENT_NOT_PUBLISHED',
  'INTEGRATION_NOT_CONNECTED',
  'COMPLIANCE_BLOCKED',
  'VOICE_PROVIDER_ERROR',
  'LLM_PROVIDER_ERROR',
  'TOOL_NOT_FOUND',
  'TOOL_EXECUTION_FAILED',
  'TOOL_INPUT_INVALID',
  'BILLING_REQUIRED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.any()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function envelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.boolean(),
    data: data.nullable(),
    error: ApiErrorSchema.nullable(),
  });
}

export type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: ApiError | null;
};

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
