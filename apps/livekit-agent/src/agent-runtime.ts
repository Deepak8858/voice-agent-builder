import { z } from 'zod';
import { AgentSpecSchema, VoicePipelineSchema, type AgentSpec } from '@voiceforge/shared';

export const DispatchMetadataSchema = z
  .object({
    workspaceId: z.string().min(1).optional(),
    // Optional at parse time for legacy jobs; attributed calls fail closed
    // before the conversation starts if tenant resolution cannot provide it.
    organizationId: z.string().min(1).optional(),
    agentId: z.string().min(1),
    callId: z.string().min(1).optional(),
    providerCallId: z.string().min(1).optional(),
    maxDurationSeconds: z.number().int().positive().optional(),
    phoneNumberId: z.string().min(1).optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
    // Which runtime to build for this call. Defaulted rather than required so a
    // job enqueued by the previous release — or a dispatch rule created before
    // this deploy — still runs, on the behavior it was created with.
    pipeline: VoicePipelineSchema.default('realtime'),
  })
  .passthrough();

export type DispatchMetadata = z.infer<typeof DispatchMetadataSchema>;

export function parseDispatchMetadata(raw: string | undefined | null): DispatchMetadata {
  if (!raw) {
    throw new Error('LiveKit dispatch metadata is required and must include agentId.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LiveKit dispatch metadata must be valid JSON.');
  }
  const result = DispatchMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`LiveKit dispatch metadata is missing required agentId: ${result.error.message}`);
  }
  return result.data;
}

export function parseAgentSpec(raw: unknown): AgentSpec {
  const result = AgentSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Agent Spec JSON is invalid: ${result.error.message}`);
  }
  return result.data;
}

export function buildVoiceForgeInstructions(spec: AgentSpec, metadata: DispatchMetadata): string {
  const rules: string[] = [];
  if (spec.conversation_rules.ask_one_question_at_a_time) rules.push('ask one question at a time');
  if (spec.conversation_rules.confirm_critical_information) rules.push('confirm critical information');
  if (spec.conversation_rules.do_not_make_up_answers) rules.push('do not make up answers');
  if (spec.conversation_rules.fallback_to_human_when_unsure) rules.push('fallback to a human when unsure');
  if (spec.compliance.opt_out_enabled) rules.push('respect opt-out requests');
  if (spec.compliance.ai_disclosure_required) rules.push('clearly disclose that you are an AI assistant');
  if (spec.compliance.recording_notice_required) rules.push('give the configured recording notice');

  const requiredFields = spec.required_fields
    .map((field) => `${field.key}${field.required ? ' (required)' : ''}: ${field.description ?? field.type}`)
    .join('\n');

  return [
    `You are ${spec.identity.agent_name}, a voice agent for ${spec.identity.business_name}.`,
    spec.identity.disclosure ? `Disclosure: ${spec.identity.disclosure}` : null,
    `Agent Spec name: ${spec.name}.`,
    spec.description ? `Description: ${spec.description}` : null,
    `Industry: ${spec.industry}. Language: ${spec.language}. Tone: ${spec.voice.tone}.`,
    `Call direction: ${metadata.direction ?? 'unspecified'}. Agent ID: ${metadata.agentId}.`,
    `Goals:\n${spec.goals.map((goal) => `- ${goal}`).join('\n')}`,
    requiredFields ? `Capture fields:\n${requiredFields}` : 'No required fields are configured.',
    `Conversation rules: ${rules.join('; ')}.`,
    spec.knowledge.retrieval_mode !== 'none' && spec.knowledge.max_chunks > 0
      ? 'For factual questions about the business, its products, services, policies, or procedures, call search_knowledge_base before answering. Use only retrieved passages. If retrieval finds nothing or fails, say the returned fallback message exactly and do not invent an answer.'
      : 'Knowledge retrieval is disabled. Do not claim to have looked up business knowledge.',
    spec.knowledge.fallback_message ? `Knowledge fallback: ${spec.knowledge.fallback_message}` : null,
    spec.handoff.enabled
      ? `Handoff is enabled. Conditions: ${spec.handoff.conditions.join('; ') || 'not configured'}.`
      : 'Handoff is disabled unless explicitly requested by platform policy.',
    'Keep responses brief, natural, and suitable for a phone call.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function firstReplyInstruction(spec: AgentSpec): string {
  const firstMessage = spec.conversation_rules.first_message?.trim();
  if (firstMessage) return `Say exactly: "${firstMessage}"`;
  return `Greet the caller as ${spec.identity.agent_name} from ${spec.identity.business_name}, then ask how you can help.`;
}

export function resolveRealtimeVoice(spec: AgentSpec, fallbackVoice: string): string {
  return spec.voice.voice_id?.trim() || fallbackVoice;
}
