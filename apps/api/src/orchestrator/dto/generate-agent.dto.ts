import { z } from 'zod';

export const CrmProviderSchema = z.enum(['pipedrive', 'hubspot', 'salesforce', 'generic_webhook']);
export type CrmProvider = z.infer<typeof CrmProviderSchema>;

export const CallDirectionSchema = z.enum(['inbound', 'outbound', 'both']);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

export const GenerateAgentRequestSchema = z.object({
  prompt: z.string().min(10),
  template_slug: z.string().optional(),
  crm_providers: z.array(CrmProviderSchema).min(1),
  call_direction: CallDirectionSchema.default('both'),
  voice_config: z.object({
    provider: z.enum(['deepgram', 'elevenlabs', 'custom']).default('deepgram'),
    voice_id: z.string().optional(),
    language: z.string().default('en'),
    stability: z.number().min(0).max(1).optional(),
  }).optional(),
  white_label: z.boolean().default(false),
});

export type GenerateAgentRequest = z.infer<typeof GenerateAgentRequestSchema>;

export class GenerateAgentDto {
  prompt!: string;
  template_slug?: string;
  crm_providers!: CrmProvider[];
  call_direction!: CallDirection;
  voice_config?: {
    provider?: 'deepgram' | 'elevenlabs' | 'custom';
    voice_id?: string;
    language?: string;
    stability?: number;
  };
  white_label?: boolean;
}
