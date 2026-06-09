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
});
