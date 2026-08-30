import { describe, expect, it } from 'vitest';
import { CreateClientInviteDtoSchema } from './white-label';

describe('CreateClientInviteDtoSchema', () => {
  // The validation pipe applies this default before the API service sees the
  // payload, so this default — not the service-side fallback — is the one an
  // HTTP caller actually hits. An invite that omits a role must not mint an
  // admin.
  it('defaults an omitted role to viewer, not admin', () => {
    const parsed = CreateClientInviteDtoSchema.parse({ email: 'client@example.com' });

    expect(parsed.role).toBe('viewer');
  });

  it('still accepts an explicit admin role', () => {
    const parsed = CreateClientInviteDtoSchema.parse({
      email: 'client@example.com',
      role: 'admin',
    });

    expect(parsed.role).toBe('admin');
  });
});
