import { z } from 'zod';

/**
 * Agent Spec JSON \u2014 the provider-neutral contract for a voice agent.
 * Mirrors docs/05_AGENT_SPEC_JSON.md.
 */

export const AgentFieldTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'date',
  'datetime',
  'phone',
  'email',
  'enum',
]);
export type AgentFieldType = z.infer<typeof AgentFieldTypeSchema>;

export const AgentFieldSchema = z.object({
  key: z.string().min(1),
  type: AgentFieldTypeSchema,
  required: z.boolean().default(false),
  description: z.string().optional(),
  enum_values: z.array(z.string()).optional(),
});
export type AgentField = z.infer<typeof AgentFieldSchema>;

export const AgentVoiceSchema = z.object({
  tone: z.string().min(1),
  voice_id: z.string().optional(),
  allow_interruptions: z.boolean().default(true),
  speaking_rate: z.number().min(0.5).max(2.0).optional(),
  /**
   * Per-language voice overrides. Key = ISO 639-1 language code (en, hi, es, etc.).
   * When set, the voice provider uses the matching language config instead of the
   * flat voice_id/speaking_rate fields above.
   */
  language_configs: z
    .record(
      z.string().min(2),
      z.object({
        voice_id: z.string().optional(),
        speaking_rate: z.number().min(0.5).max(2.0).optional(),
      }),
    )
    .optional(),
});

export const AgentIdentitySchema = z.object({
  business_name: z.string().min(1),
  agent_name: z.string().min(1),
  disclosure: z.string().optional(),
});

export const AgentConversationRulesSchema = z.object({
  ask_one_question_at_a_time: z.boolean().default(true),
  confirm_critical_information: z.boolean().default(true),
  do_not_make_up_answers: z.boolean().default(true),
  fallback_to_human_when_unsure: z.boolean().default(true),
  first_message: z.string().optional(),
});

export const AgentKnowledgeConfigSchema = z.object({
  retrieval_mode: z.enum(['agent_scoped', 'workspace_scoped', 'none']).default('agent_scoped'),
  max_chunks: z.number().int().min(0).max(20).default(5),
  fallback_message: z.string().optional(),
  source_ids: z.array(z.string().uuid()).default([]),
});

export const AgentToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  requires_confirmation: z.boolean().default(false),
  input_schema: z
    .object({
      type: z.literal('object'),
      properties: z.record(z.string(), z.any()),
      required: z.array(z.string()).default([]),
    })
    .passthrough(),
  permissions: z.array(z.string()).optional(),
});
export type AgentTool = z.infer<typeof AgentToolSchema>;

export const AgentHandoffSchema = z.object({
  enabled: z.boolean().default(true),
  target_phone: z.string().optional(),
  conditions: z.array(z.string()).default([]),
});

export const AgentComplianceSchema = z.object({
  ai_disclosure_required: z.boolean().default(true),
  recording_notice_required: z.boolean().default(false),
  opt_out_enabled: z.boolean().default(true),
  consent_required_for_outbound: z.boolean().default(true),
  allowed_call_window: z
    .object({
      timezone: z.string(),
      start_hour: z.number().int().min(0).max(23),
      end_hour: z.number().int().min(0).max(23),
    })
    .optional(),
});

export const AgentAnalyticsConfigSchema = z.object({
  success_events: z.array(z.string()).default([]),
});

/**
 * Flow node types from docs/05_AGENT_SPEC_JSON.md "Flow Node Types":
 * start, speak, ask_question, condition, knowledge_lookup, tool_call, transfer, send_message, end, fallback.
 */
const BaseNode = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  next: z.string().optional(),
});

export const FlowNodeSchema = z.discriminatedUnion('type', [
  BaseNode.extend({ type: z.literal('start') }),
  BaseNode.extend({ type: z.literal('speak'), text: z.string() }),
  BaseNode.extend({
    type: z.literal('ask_question'),
    question: z.string(),
    capture_field: z.string().optional(),
  }),
  BaseNode.extend({
    type: z.literal('condition'),
    expression: z.string(),
    on_true: z.string(),
    on_false: z.string(),
  }),
  BaseNode.extend({
    type: z.literal('knowledge_lookup'),
    query_field: z.string().optional(),
  }),
  BaseNode.extend({
    type: z.literal('tool_call'),
    tool_name: z.string(),
    arguments: z.record(z.string(), z.any()).optional(),
  }),
  BaseNode.extend({ type: z.literal('transfer'), target_phone: z.string().optional() }),
  BaseNode.extend({
    type: z.literal('send_message'),
    channel: z.enum(['sms', 'email']).default('sms'),
    body: z.string(),
  }),
  BaseNode.extend({ type: z.literal('end') }),
  BaseNode.extend({ type: z.literal('fallback'), message: z.string().optional() }),
]);
export type FlowNode = z.infer<typeof FlowNodeSchema>;

export const AgentFlowSchema = z.object({
  nodes: z.array(FlowNodeSchema).min(2),
  start_node_id: z.string().min(1),
});

export const AgentTypeSchema = z.enum([
  'inbound_receptionist',
  'outbound_reminder',
  'outbound_qualifier',
  'outbound_confirmation',
  'outbound_survey',
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentSpecSchema = z
  .object({
    schema_version: z.literal('1.0'),
    name: z.string().min(1),
    description: z.string().optional(),
    industry: z.string().min(1),
    agent_type: AgentTypeSchema,
    language: z.string().min(2).default('en'),
    voice: AgentVoiceSchema,
    identity: AgentIdentitySchema,
    goals: z.array(z.string()).min(1),
    required_fields: z.array(AgentFieldSchema).default([]),
    conversation_rules: AgentConversationRulesSchema.default({}),
    knowledge: AgentKnowledgeConfigSchema.default({}),
    tools: z.array(AgentToolSchema).default([]),
    handoff: AgentHandoffSchema.default({ enabled: true, conditions: [] }),
    compliance: AgentComplianceSchema,
    analytics: AgentAnalyticsConfigSchema.default({ success_events: [] }),
    flow: AgentFlowSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    // Publish-gate validation rules from docs/05_AGENT_SPEC_JSON.md "Validation Rules".
    if (spec.handoff.enabled && spec.handoff.conditions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['handoff', 'conditions'],
        message: 'Handoff is enabled but no conditions are defined.',
      });
    }
    if (
      spec.agent_type.startsWith('outbound_') &&
      !spec.compliance.consent_required_for_outbound
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compliance', 'consent_required_for_outbound'],
        message: 'Outbound agents must require consent.',
      });
    }
    if (spec.flow) {
      const ids = new Set(spec.flow.nodes.map((n) => n.id));
      if (!ids.has(spec.flow.start_node_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flow', 'start_node_id'],
          message: 'start_node_id does not reference a node in flow.nodes.',
        });
      }
      const hasEnd = spec.flow.nodes.some((n) => n.type === 'end');
      if (!hasEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['flow'],
          message: 'Flow must contain at least one `end` node.',
        });
      }
    }
  });

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AGENT_SPEC_SCHEMA_VERSION = '1.0' as const;
