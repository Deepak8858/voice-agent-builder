import { z } from 'zod';

const E164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be E.164, for example +14155551234');

export const OutboundCampaignContactSchema = z
  .object({
    phone: E164PhoneSchema,
    full_name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().optional(),
    custom_data: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type OutboundCampaignContact = z.infer<typeof OutboundCampaignContactSchema>;

export const OutboundCampaignScheduleSchema = z
  .object({
    max_calls_per_hour: z.number().int().min(1).max(500).default(10),
    max_concurrent: z.number().int().min(1).max(25).default(3),
  })
  .default({ max_calls_per_hour: 10, max_concurrent: 3 });
export type OutboundCampaignSchedule = z.infer<typeof OutboundCampaignScheduleSchema>;

export const CreateOutboundCampaignDtoSchema = z
  .object({
    agent_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    contacts: z.array(OutboundCampaignContactSchema).min(1).max(500),
    schedule: OutboundCampaignScheduleSchema,
  })
  .strict();
export type CreateOutboundCampaignDto = z.infer<typeof CreateOutboundCampaignDtoSchema>;
