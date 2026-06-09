import { z } from 'zod';

export const WorkspaceCrmProviderSchema = z.enum([
  'pipedrive',
  'hubspot',
  'salesforce',
  'generic_webhook',
]);
export type WorkspaceCrmProvider = z.infer<typeof WorkspaceCrmProviderSchema>;

export const WorkspaceCrmStatusSchema = z.enum(['pending', 'active', 'invalid']);
export type WorkspaceCrmStatus = z.infer<typeof WorkspaceCrmStatusSchema>;

const PublicHttpsUrlSchema = z.string().url().refine((value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return ![
      /^localhost$/,
      /^127\./,
      /^0\.0\.0\.0$/,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
      /\.local$/,
      /\.internal$/,
    ].some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}, 'URL must be a public HTTPS endpoint');

const TokenCredentialsSchema = z
  .object({
    api_key: z.string().trim().min(1),
    base_url: z.string().trim().url().optional(),
  })
  .strict();

const SalesforceCredentialsSchema = z
  .object({
    api_key: z.string().trim().min(1),
    base_url: z.string().trim().url(),
  })
  .strict();

const GenericWebhookCredentialsSchema = z
  .object({
    base_url: PublicHttpsUrlSchema,
  })
  .strict();

export const CreateWorkspaceCrmCredentialDtoSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('pipedrive'),
    credentials: TokenCredentialsSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    provider: z.literal('hubspot'),
    credentials: TokenCredentialsSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    provider: z.literal('salesforce'),
    credentials: SalesforceCredentialsSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    provider: z.literal('generic_webhook'),
    credentials: GenericWebhookCredentialsSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
]);
export type CreateWorkspaceCrmCredentialDto = z.infer<typeof CreateWorkspaceCrmCredentialDtoSchema>;

export const UpdateWorkspaceCrmCredentialDtoSchema = z
  .object({
    credentials: z.union([
      TokenCredentialsSchema,
      SalesforceCredentialsSchema,
      GenericWebhookCredentialsSchema,
    ]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: WorkspaceCrmStatusSchema.optional(),
  })
  .strict();
export type UpdateWorkspaceCrmCredentialDto = z.infer<typeof UpdateWorkspaceCrmCredentialDtoSchema>;
