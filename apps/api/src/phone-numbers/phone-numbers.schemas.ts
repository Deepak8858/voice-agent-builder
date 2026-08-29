import { z } from 'zod';

/**
 * E.164, restated because `packages/shared/src/schemas/telephony.ts` keeps its
 * `E164PhoneSchema` module-private. Same pattern deliberately, so a number this
 * surface accepts is one the telephony surface would also accept.
 */
const E164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Phone number must be E.164, for example +14155551234');

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

export const AddByoPhoneNumberDtoSchema = z
  .object({
    phone_number: E164PhoneSchema,
    // A Twilio IncomingPhoneNumber SID is `PN` + 32 hex. The stored value is
    // interpolated into a Twilio API *path* when the number is released, so it
    // is pinned to that shape rather than accepted as free text.
    twilio_sid: z
      .string()
      .trim()
      .regex(/^PN[0-9a-fA-F]{32}$/, 'Twilio SID must be PN followed by 32 hex characters')
      .optional(),
  })
  .strict();
export type AddByoPhoneNumberDto = z.infer<typeof AddByoPhoneNumberDtoSchema>;
