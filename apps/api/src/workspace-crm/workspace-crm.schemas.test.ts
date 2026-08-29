import { describe, expect, it } from 'vitest';
import {
  CreateWorkspaceCrmCredentialDtoSchema,
  UpdateWorkspaceCrmCredentialDtoSchema,
} from './workspace-crm.schemas';

describe('workspace CRM credential schemas', () => {
  it('accepts HubSpot private app tokens', () => {
    const parsed = CreateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'hubspot',
      credentials: { api_key: 'pat-na1-abc123' },
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts generic_webhook only with a public HTTPS webhook URL', () => {
    const parsed = CreateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'generic_webhook',
      credentials: { base_url: 'https://crm.example.com/voiceforge/contact' },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects private webhook destinations', () => {
    const parsed = CreateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'generic_webhook',
      credentials: { base_url: 'http://localhost:4000/hooks/crm' },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects invalid providers and statuses', () => {
    expect(CreateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'zoho',
      credentials: { api_key: 'token' },
    }).success).toBe(false);

    expect(UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      status: 'connected',
    }).success).toBe(false);
  });

  it('accepts a status-only update without a provider', () => {
    expect(UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      status: 'active',
    }).success).toBe(true);
  });

  it('rejects a credentials update that does not name its provider', () => {
    expect(UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      credentials: { api_key: 'token' },
    }).success).toBe(false);
  });

  it('validates updated credentials against the named provider branch', () => {
    // Missing base_url used to slip through the pipedrive/hubspot token branch.
    const parsed = UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'salesforce',
      credentials: { api_key: 'token' },
    });

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error)).toContain('base_url');

    expect(UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'salesforce',
      credentials: { api_key: 'token', base_url: 'https://example.my.salesforce.com' },
    }).success).toBe(true);
  });

  it('holds generic_webhook updates to the public HTTPS rule', () => {
    expect(UpdateWorkspaceCrmCredentialDtoSchema.safeParse({
      provider: 'generic_webhook',
      credentials: { base_url: 'http://localhost:4000/hooks/crm' },
    }).success).toBe(false);
  });
});
