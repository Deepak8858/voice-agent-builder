import { z } from 'zod';

/**
 * Phase 7 — Analytics. Mirrors docs/12_ANALYTICS.md.
 *
 * Two surfaces:
 *  - AnalyticsEvent: append-only event stream (call.started, call.blocked,
 *    appointment.booked, lead.qualified, tool.failed, transfer.completed, ...)
 *  - Aggregated metrics: workspace, agent, compliance, outcome breakdown.
 */

// --- call outcomes ------------------------------------------------------

export const CallOutcomeSchema = z.enum([
  'appointment_booked',
  'lead_qualified',
  'message_taken',
  'human_transfer_completed',
  'caller_hung_up',
  'no_answer',
  'voicemail',
  'tool_failed',
  'agent_failed',
  'not_interested',
  'opted_out',
  'test_completed',
  'other',
]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const CALL_OUTCOMES = CallOutcomeSchema.options;

const SUCCESS_OUTCOMES_TUPLE = [
  'appointment_booked',
  'lead_qualified',
  'human_transfer_completed',
  'message_taken',
] as const satisfies readonly CallOutcome[];

export const SUCCESS_OUTCOMES: readonly CallOutcome[] = SUCCESS_OUTCOMES_TUPLE;

// --- event ingestion ----------------------------------------------------

export const RecordAnalyticsEventDtoSchema = z.object({
  event_type: z.string().min(1).max(64),
  agent_id: z.string().uuid().optional(),
  call_id: z.string().uuid().optional(),
  payload: z.record(z.string(), z.any()).optional(),
  occurred_at: z.string().datetime().optional(),
});
export type RecordAnalyticsEventDto = z.infer<typeof RecordAnalyticsEventDtoSchema>;

export const AnalyticsEventSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  agent_id: z.string().uuid().nullable(),
  call_id: z.string().uuid().nullable(),
  event_type: z.string(),
  payload: z.record(z.string(), z.any()).nullable(),
  occurred_at: z.string(),
});
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

// --- query --------------------------------------------------------------

export const MetricsRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  agent_id: z.string().uuid().optional(),
});
export type MetricsRangeQuery = z.infer<typeof MetricsRangeQuerySchema>;

// --- aggregates ---------------------------------------------------------

export const OutcomeCountSchema = z.object({
  outcome: z.string(),
  count: z.number().int().min(0),
});
export type OutcomeCount = z.infer<typeof OutcomeCountSchema>;

export const WorkspaceMetricsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  total_calls: z.number().int().min(0),
  total_minutes: z.number().min(0),
  answer_rate: z.number().min(0).max(1),
  failed_call_rate: z.number().min(0).max(1),
  success_rate: z.number().min(0).max(1),
  blocked_calls: z.number().int().min(0),
  outcomes: z.array(OutcomeCountSchema),
  agents_active: z.number().int().min(0),
});
export type WorkspaceMetrics = z.infer<typeof WorkspaceMetricsSchema>;

export const AgentMetricsRowSchema = z.object({
  agent_id: z.string().uuid(),
  agent_name: z.string(),
  total_calls: z.number().int().min(0),
  success_rate: z.number().min(0).max(1),
  booking_rate: z.number().min(0).max(1),
  qualification_rate: z.number().min(0).max(1),
  transfer_rate: z.number().min(0).max(1),
  fallback_rate: z.number().min(0).max(1),
  tool_success_rate: z.number().min(0).max(1),
  average_duration_seconds: z.number().min(0),
  average_evaluation_score: z.number().min(0).max(1),
});
export type AgentMetricsRow = z.infer<typeof AgentMetricsRowSchema>;

export const AgentMetricsResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  agents: z.array(AgentMetricsRowSchema),
});
export type AgentMetricsResponse = z.infer<typeof AgentMetricsResponseSchema>;

export const ComplianceMetricsSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  blocked_calls: z.number().int().min(0),
  block_reasons: z.array(z.object({ code: z.string(), count: z.number().int().min(0) })),
  opt_outs: z.number().int().min(0),
  dnc_hits: z.number().int().min(0),
  missing_consent: z.number().int().min(0),
});
export type ComplianceMetrics = z.infer<typeof ComplianceMetricsSchema>;

// --- improvement suggestions -------------------------------------------

export const ImprovementSuggestionSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type ImprovementSuggestionSeverity = z.infer<
  typeof ImprovementSuggestionSeveritySchema
>;

export const ImprovementSuggestionSchema = z.object({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: ImprovementSuggestionSeveritySchema.default('info'),
  evidence_count: z.number().int().min(0).default(0),
});
export type ImprovementSuggestion = z.infer<typeof ImprovementSuggestionSchema>;

export const ImprovementSuggestionsResponseSchema = z.object({
  agent_id: z.string().uuid(),
  generated_at: z.string(),
  suggestions: z.array(ImprovementSuggestionSchema),
});
export type ImprovementSuggestionsResponse = z.infer<
  typeof ImprovementSuggestionsResponseSchema
>;
