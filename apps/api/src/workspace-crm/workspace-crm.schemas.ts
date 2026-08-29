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

const CREDENTIALS_SCHEMA_BY_PROVIDER: Record<WorkspaceCrmProvider, z.ZodTypeAny> = {
  pipedrive: TokenCredentialsSchema,
  hubspot: TokenCredentialsSchema,
  salesforce: SalesforceCredentialsSchema,
  generic_webhook: GenericWebhookCredentialsSchema,
};

// The credential schemas share no literal field, so a bare union of them
// cannot tell WHICH provider's shape a payload was aiming for — a salesforce
// payload missing its required base_url used to slip through the token branch,
// and every malformed payload got another branch's error. Replacing
// credentials therefore requires naming the provider, which is dispatched
// (rather than z.discriminatedUnion-ed with a provider-less branch alongside:
// zod's union then reports the provider-less branch's unrecognized-key error
// instead of the credential one) to the one schema to validate against. The
// service rejects a provider that does not match the stored row.
export const UpdateWorkspaceCrmCredentialDtoSchema = z
  .object({
    provider: WorkspaceCrmProviderSchema.optional(),
    credentials: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: WorkspaceCrmStatusSchema.optional(),
  })
  .strict()
  .transform((value, ctx) => {
    if (value.credentials === undefined) {
      if (value.provider !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['provider'],
          message: 'provider is only accepted alongside replacement credentials.',
        });
        return z.NEVER;
      }
      return value;
    }
    if (value.provider === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['provider'],
        message: 'Name the provider the replacement credentials belong to.',
      });
      return z.NEVER;
    }
    const parsed = CREDENTIALS_SCHEMA_BY_PROVIDER[value.provider].safeParse(value.credentials);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['credentials', ...issue.path] });
      }
      return z.NEVER;
    }
    return { ...value, credentials: parsed.data as Record<string, unknown> };
  });
export type UpdateWorkspaceCrmCredentialDto = z.infer<typeof UpdateWorkspaceCrmCredentialDtoSchema>;
