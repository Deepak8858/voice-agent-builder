import { z } from 'zod';

export const ProvisionPhoneNumberDtoSchema = z
  .object({
    // Interpolated into the Twilio AvailablePhoneNumbers query string, so this
    // is pinned to three digits rather than merely non-empty: a value
    // containing `&` would otherwise append parameters to that carrier search.
    area_code: z.string().trim().regex(/^\d{3}$/, 'Area code must be three digits'),
    // `@db.Uuid` on TwilioPhoneNumber.agentId, so a non-UUID reaches Postgres
    // as a cast error rather than a 404.
    agent_id: z.string().uuid().optional(),
  })
  .strict();
export type ProvisionPhoneNumberDto = z.infer<typeof ProvisionPhoneNumberDtoSchema>;
