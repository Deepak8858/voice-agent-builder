import { z } from 'zod';

export const CallDirectionSchema = z.enum(['inbound', 'outbound', 'browser_test']);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

export const CallStatusSchema = z.enum([
  'queued',
  'ringing',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
]);
export type CallStatus = z.infer<typeof CallStatusSchema>;

export const StartTestSessionDtoSchema = z.object({
  agent_version_id: z.string().uuid().optional(),
  contact_name: z.string().max(120).optional(),
});
export type StartTestSessionDto = z.infer<typeof StartTestSessionDtoSchema>;

export const StartOutboundCallDtoSchema = z.object({
  to_number: z.string().min(5).max(32),
  from_number: z.string().min(5).max(32).optional(),
  contact_name: z.string().max(120).optional(),
  agent_version_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});
export type StartOutboundCallDto = z.infer<typeof StartOutboundCallDtoSchema>;

export const CallTurnSchema = z.object({
  speaker: z.enum(['agent', 'caller']),
  text: z.string(),
  at_ms: z.number().int().min(0),
});
export type CallTurn = z.infer<typeof CallTurnSchema>;

export const TestSessionResultSchema = z.object({
  call_id: z.string().uuid(),
  test_session_id: z.string(),
  web_socket_url: z.string().nullable(),
  token: z.string().nullable(),
  expires_at: z.string(),
});
export type TestSessionResult = z.infer<typeof TestSessionResultSchema>;

export const CallSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  agent_version_id: z.string().uuid().nullable(),
  direction: CallDirectionSchema,
  status: CallStatusSchema,
  provider: z.string(),
  from_number: z.string().nullable(),
  to_number: z.string().nullable(),
  contact_name: z.string().nullable(),
  duration_seconds: z.number().int().nullable(),
  outcome: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  created_at: z.string(),
});
export type CallSummary = z.infer<typeof CallSummarySchema>;

export const CallEvaluationMetricSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(1),
  reason: z.string().optional(),
});
export type CallEvaluationMetric = z.infer<typeof CallEvaluationMetricSchema>;

export const CallEvaluationSchema = z.object({
  id: z.string().uuid(),
  call_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  agent_version_id: z.string().uuid().nullable(),
  overall_score: z.number().min(0).max(1),
  metric_scores: z.array(CallEvaluationMetricSchema),
  summary: z.string().nullable(),
  evaluated_by: z.enum(['rule_based', 'llm', 'manual']),
  created_at: z.string(),
});
export type CallEvaluation = z.infer<typeof CallEvaluationSchema>;

export const CallDetailSchema = CallSummarySchema.extend({
  transcript_text: z.string().nullable(),
  recording_url: z.string().nullable(),
  turns: z.array(CallTurnSchema),
  agent_name: z.string().nullable(),
  evaluation: CallEvaluationSchema.nullable(),
});
export type CallDetail = z.infer<typeof CallDetailSchema>;
