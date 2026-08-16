import { z } from 'zod';
import { AgentSpecSchema } from './agent-spec';

// ---------------------------------------------------------------------------
// Chat-to-agent generation sessions (server-persisted, refresh-safe).
// ---------------------------------------------------------------------------

export const AgentGenSessionStatusSchema = z.enum([
  'awaiting_user',
  'generating',
  'completed',
  'failed',
]);
export type AgentGenSessionStatus = z.infer<typeof AgentGenSessionStatusSchema>;

export const AgentGenMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
  at: z.string(), // ISO timestamp
});
export type AgentGenMessage = z.infer<typeof AgentGenMessageSchema>;

export const GEN_PROMPT_MAX_LENGTH = 4000;

export const SendGenMessageDtoSchema = z.object({
  content: z.string().min(1).max(GEN_PROMPT_MAX_LENGTH),
  // Optional context, typically attached to the first message only.
  context: z
    .object({
      template_slug: z.string().max(120).optional(),
      business_name: z.string().max(200).optional(),
      timezone: z.string().max(64).optional(),
      call_direction: z.enum(['inbound', 'outbound', 'both']).optional(),
      crm_providers: z
        .array(z.enum(['pipedrive', 'hubspot', 'salesforce', 'generic_webhook']))
        .max(4)
        .optional(),
      voice_config: z
        .object({
          stt_model: z.string().max(64).optional(),
          tts_voice: z.string().max(64).optional(),
        })
        .optional(),
      knowledge_source_ids: z.array(z.string().uuid()).max(20).optional(),
    })
    .optional(),
});
export type SendGenMessageDto = z.infer<typeof SendGenMessageDtoSchema>;

export const FinalizeGenSessionDtoSchema = z.object({
  publish: z.boolean().optional().default(false),
  // Client may send a locally edited spec; validated against AgentSpecSchema.
  spec_override: z.unknown().optional(),
});
export type FinalizeGenSessionDto = z.infer<typeof FinalizeGenSessionDtoSchema>;

export const AgentGenSessionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  status: AgentGenSessionStatusSchema,
  messages: z.array(AgentGenMessageSchema),
  current_spec: z.unknown().nullable(),
  spec_valid: z.boolean(),
  agent_id: z.string().uuid().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AgentGenSession = z.infer<typeof AgentGenSessionSchema>;

// Result contract the LLM chat generation must satisfy.
export const ChatGenerateResultSchema = z.object({
  assistant_message: z.string().min(1),
  spec: AgentSpecSchema,
});
export type ChatGenerateResult = z.infer<typeof ChatGenerateResultSchema>;
