import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CrmExecutor, type CrmContactArgs } from '../tools/crm-executor';
import type { CrmProvider } from '../tools/crm-executor';
import { AppError } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../security/encryption.service';
import type {
  CreateWorkspaceCrmCredentialDto,
  UpdateWorkspaceCrmCredentialDto,
} from './workspace-crm.schemas';

@Injectable()
export class WorkspaceCrmService {
  private readonly logger = new Logger(WorkspaceCrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmExecutor: CrmExecutor,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.workspaceCrmCredential.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toPublicCredential(row));
  }

  async create(
    workspaceId: string,
    actorUserId: string,
    dto: CreateWorkspaceCrmCredentialDto,
  ) {
    const created = await this.prisma.workspaceCrmCredential.create({
      data: {
        workspaceId,
        provider: dto.provider,
        credentials: this.encryption.encryptJson(dto.credentials) as unknown as Prisma.InputJsonValue,
        config: (dto.config as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        status: 'pending',
      },
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'crm_credential.create',
      resourceType: 'workspace_crm_credential',
      resourceId: created.id,
      metadata: { provider: dto.provider },
    });
    return this.toPublicCredential(created);
  }

  async update(
    workspaceId: string,
    credentialId: string,
    actorUserId: string,
    dto: UpdateWorkspaceCrmCredentialDto,
  ) {
    await this.getScopedCredential(workspaceId, credentialId);
    const data: Record<string, unknown> = {};
    if (dto.credentials) {
      data.credentials = this.encryption.encryptJson(dto.credentials) as unknown as Prisma.InputJsonValue;
    }
    if (dto.config) data.config = dto.config as Prisma.InputJsonValue;
    if (dto.status) data.status = dto.status;
    const updated = await this.prisma.workspaceCrmCredential.update({
      where: { id: credentialId },
      data,
    });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'crm_credential.update',
      resourceType: 'workspace_crm_credential',
      resourceId: credentialId,
      metadata: { changed: Object.keys(data) },
    });
    return this.toPublicCredential(updated);
  }

  async delete(workspaceId: string, credentialId: string, actorUserId: string) {
    const existing = await this.getScopedCredential(workspaceId, credentialId);
    await this.prisma.workspaceCrmCredential.delete({ where: { id: credentialId } });
    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'crm_credential.delete',
      resourceType: 'workspace_crm_credential',
      resourceId: credentialId,
      metadata: { provider: existing.provider },
    });
  }

  async test(workspaceId: string, credentialId: string, actorUserId: string) {
    const cred = await this.getScopedCredential(workspaceId, credentialId);
    const provider = this.executorProvider(cred.provider);
    const credentials = this.readCredentials(cred.credentials);

    const testContact: CrmContactArgs = {
      full_name: 'VoiceForge Test Contact',
      phone: '+15551234567',
      email: 'test@voiceforge.dev',
      notes: 'VoiceForge connection test',
    };

    try {
      await this.crmExecutor.createContact(provider, credentials, testContact);
      await this.prisma.workspaceCrmCredential.update({
        where: { id: credentialId },
        data: { status: 'active', lastTestedAt: new Date() },
      });
      await this.audit.log({
        workspaceId,
        actorUserId,
        action: 'crm_credential.test_success',
        resourceType: 'workspace_crm_credential',
        resourceId: credentialId,
        metadata: { provider: cred.provider },
      });
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      await this.prisma.workspaceCrmCredential.update({
        where: { id: credentialId },
        data: { status: 'invalid', lastTestedAt: new Date() },
      });
      await this.audit.log({
        workspaceId,
        actorUserId,
        action: 'crm_credential.test_failed',
        resourceType: 'workspace_crm_credential',
        resourceId: credentialId,
        metadata: { provider: cred.provider },
      });
      return { success: false, error: msg };
    }
  }

  private async getScopedCredential(workspaceId: string, credentialId: string) {
    const cred = await this.prisma.workspaceCrmCredential.findFirst({
      where: { id: credentialId, workspaceId },
    });
    if (!cred) {
      throw new AppError('NOT_FOUND', 'CRM credential not found.', 404, { credentialId });
    }
    return cred;
  }

  private readCredentials(value: unknown): Record<string, string> {
    if (this.isEncryptedEnvelope(value)) {
      return this.encryption.decryptJson<Record<string, string>>(value);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, string>;
    }
    throw new AppError('INTERNAL_ERROR', 'CRM credentials are malformed.', 500);
  }

  private executorProvider(provider: string): CrmProvider {
    return provider === 'generic_webhook' ? 'generic' : (provider as CrmProvider);
  }

  private toPublicCredential(row: {
    id: string;
    provider: string;
    status: string;
    config?: Prisma.JsonValue | null;
    lastTestedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      config: row.config ?? null,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
    };
  }

  private isEncryptedEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return maybe.v === 1 && maybe.alg === 'aes-256-gcm';
  }
}
