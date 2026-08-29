import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceCrmService } from './workspace-crm.service';

function makeService() {
  const prisma = {
    workspaceCrmCredential: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  const crmExecutor = {
    createContact: vi.fn(),
  };
  const encryption = {
    encryptJson: vi.fn((value: unknown) => ({ v: 1, alg: 'aes-256-gcm', encrypted: value })),
    decryptJson: vi.fn((value: unknown) => {
      if (value && typeof value === 'object' && 'encrypted' in value) {
        return (value as { encrypted: unknown }).encrypted;
      }
      return value;
    }),
  };
  const audit = {
    log: vi.fn(async () => undefined),
  };

  return {
    prisma,
    crmExecutor,
    encryption,
    audit,
    service: new WorkspaceCrmService(
      prisma as never,
      crmExecutor as never,
      encryption as never,
      audit as never,
    ),
  };
}

describe('WorkspaceCrmService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts credentials, writes an audit log, and returns no plaintext secrets on create', async () => {
    const { service, prisma, encryption, audit } = makeService();
    prisma.workspaceCrmCredential.create.mockResolvedValue({
      id: 'cred-1',
      workspaceId: 'ws-1',
      provider: 'hubspot',
      credentials: { v: 1, alg: 'aes-256-gcm', encrypted: { api_key: 'secret' } },
      config: null,
      status: 'pending',
      lastTestedAt: null,
      createdAt: new Date('2026-06-09T00:00:00.000Z'),
    });

    const result = await service.create('ws-1', 'user-1', {
      provider: 'hubspot',
      credentials: { api_key: 'secret' },
    });

    expect(encryption.encryptJson).toHaveBeenCalledWith({ api_key: 'secret' });
    expect(prisma.workspaceCrmCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 'ws-1',
        provider: 'hubspot',
        credentials: { v: 1, alg: 'aes-256-gcm', encrypted: { api_key: 'secret' } },
      }),
    });
    expect(result).not.toHaveProperty('credentials');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      action: 'crm_credential.create',
      resourceType: 'workspace_crm_credential',
      resourceId: 'cred-1',
      metadata: { provider: 'hubspot' },
    }));
  });

  it('tests generic_webhook credentials through the generic CRM executor provider', async () => {
    const { service, prisma, crmExecutor, encryption } = makeService();
    prisma.workspaceCrmCredential.findFirst.mockResolvedValue({
      id: 'cred-1',
      workspaceId: 'ws-1',
      provider: 'generic_webhook',
      credentials: { v: 1, alg: 'aes-256-gcm', encrypted: { base_url: 'https://crm.example.com/hooks' } },
      status: 'pending',
    });
    prisma.workspaceCrmCredential.update.mockResolvedValue({});
    crmExecutor.createContact.mockResolvedValue({
      contact_id: 'contact-1',
      status: 'created',
      provider: 'generic',
    });

    await expect(service.test('ws-1', 'cred-1', 'user-1')).resolves.toEqual({ success: true });

    expect(encryption.decryptJson).toHaveBeenCalledWith({
      v: 1,
      alg: 'aes-256-gcm',
      encrypted: { base_url: 'https://crm.example.com/hooks' },
    });
    expect(crmExecutor.createContact).toHaveBeenCalledWith(
      'generic',
      { base_url: 'https://crm.example.com/hooks' },
      expect.objectContaining({ full_name: 'VoiceForge Test Contact' }),
    );
  });

  it('rejects a credentials update labeled with a different provider', async () => {
    const { service, prisma } = makeService();
    prisma.workspaceCrmCredential.findFirst.mockResolvedValue({
      id: 'cred-1',
      workspaceId: 'ws-1',
      provider: 'hubspot',
      status: 'active',
    });

    await expect(service.update('ws-1', 'cred-1', 'user-1', {
      provider: 'generic_webhook',
      credentials: { base_url: 'https://crm.example.com/hooks' },
    })).rejects.toMatchObject({ errorCode: 'VALIDATION_ERROR' });

    expect(prisma.workspaceCrmCredential.update).not.toHaveBeenCalled();
  });

  it('does not update credentials outside the current workspace', async () => {
    const { service, prisma } = makeService();
    prisma.workspaceCrmCredential.findFirst.mockResolvedValue(null);

    await expect(service.update('ws-1', 'cred-2', 'user-1', {
      status: 'active',
    })).rejects.toMatchObject({ errorCode: 'NOT_FOUND' });

    expect(prisma.workspaceCrmCredential.update).not.toHaveBeenCalled();
  });
});
