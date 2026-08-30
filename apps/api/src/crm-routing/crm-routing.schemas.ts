import { z } from 'zod';
import { WorkspaceCrmProviderSchema } from '../workspace-crm/workspace-crm.schemas';

export const CreateCrmRoutingRuleDtoSchema = z
  .object({
    keyword: z.string().trim().min(1).max(100),
    provider: WorkspaceCrmProviderSchema,
    action: z.enum(['primary', 'secondary']),
    agent_id: z.string().trim().min(1).optional(),
  })
  .strict();
export type CreateCrmRoutingRuleDto = z.infer<typeof CreateCrmRoutingRuleDtoSchema>;
