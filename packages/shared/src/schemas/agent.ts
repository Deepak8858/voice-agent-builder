import { z } from 'zod';
import { AgentSpecSchema, AgentTypeSchema } from './agent-spec';

export const AgentStatusSchema = z.enum(['draft', 'published', 'paused', 'archived']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentDeploymentStatusSchema = z.enum([
  'not_deployed',
  'deploying',
  'deployed',
  'failed',
]);
export type AgentDeploymentStatus = z.infer<typeof AgentDeploymentStatusSchema>;

export const CreateAgentDtoSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  industry: z.string().min(1),
  agent_type: AgentTypeSchema,
  spec: AgentSpecSchema.optional(),
});
export type CreateAgentDto = z.infer<typeof CreateAgentDtoSchema>;

export const UpdateAgentDtoSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  industry: z.string().min(1).optional(),
});
export type UpdateAgentDto = z.infer<typeof UpdateAgentDtoSchema>;

export const GenerateAgentDtoSchema = z.object({
  prompt: z.string().min(10).max(4000),
  template_slug: z.string().optional(),
  business_context: z
    .object({
      business_name: z.string().optional(),
      timezone: z.string().optional(),
      industry_hint: z.string().optional(),
    })
    .optional(),
  knowledge_source_ids: z.array(z.string().uuid()).default([]).optional(),
});
export type GenerateAgentDto = z.infer<typeof GenerateAgentDtoSchema>;

export const CreateAgentVersionDtoSchema = z.object({
  spec: AgentSpecSchema,
  note: z.string().max(500).optional(),
});
export type CreateAgentVersionDto = z.infer<typeof CreateAgentVersionDtoSchema>;

export const AgentSummarySchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  industry: z.string(),
  agent_type: AgentTypeSchema,
  status: AgentStatusSchema,
  active_version_id: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentVersionSummarySchema = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  version_number: z.number().int().min(1),
  deployment_status: AgentDeploymentStatusSchema,
  provider: z.string().nullable(),
  provider_runtime_id: z.string().nullable(),
  created_at: z.string(),
  note: z.string().nullable(),
});
export type AgentVersionSummary = z.infer<typeof AgentVersionSummarySchema>;

export const AgentDetailSchema = AgentSummarySchema.extend({
  versions: z.array(AgentVersionSummarySchema),
  active_spec: AgentSpecSchema.nullable(),
});
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

export const GenerateAgentResultSchema = z.object({
  spec: AgentSpecSchema,
  suggested_name: z.string(),
  rationale: z.string(),
  matched_template_slug: z.string().nullable(),
});
export type GenerateAgentResult = z.infer<typeof GenerateAgentResultSchema>;
