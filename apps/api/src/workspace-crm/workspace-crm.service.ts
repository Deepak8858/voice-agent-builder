import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CrmExecutor, type CrmContactArgs } from '../tools/crm-executor';
import type { CrmProvider } from '../tools/crm-executor';

@Injectable()
export class WorkspaceCrmService {
  private readonly logger = new Logger(WorkspaceCrmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crmExecutor: CrmExecutor,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.workspaceCrmCredential.findMany({ where: { workspaceId } });
  }

  async create(
    workspaceId: string,
    dto: { provider: string; credentials: Record<string, string>; config?: Record<string, unknown> },
  ) {
    return this.prisma.workspaceCrmCredential.create({
      data: {
        workspaceId,
        provider: dto.provider,
        credentials: dto.credentials as object,
        config: dto.config as object | undefined,
        status: 'pending',
      },
    });
  }

  async update(
    workspaceId: string,
    credentialId: string,
    dto: { credentials?: Record<string, string>; config?: Record<string, unknown>; status?: string },
  ) {
    const data: Record<string, unknown> = {};
    if (dto.credentials) data.credentials = dto.credentials as object;
    if (dto.config) data.config = dto.config as object;
    if (dto.status) data.status = dto.status;
    return this.prisma.workspaceCrmCredential.update({
      where: { id: credentialId },
      data,
    });
  }

  async delete(workspaceId: string, credentialId: string) {
    await this.prisma.workspaceCrmCredential.delete({ where: { id: credentialId } });
  }

  async test(workspaceId: string, credentialId: string) {
    const cred = await this.prisma.workspaceCrmCredential.findUnique({ where: { id: credentialId } });
    if (!cred) throw new Error('Credential not found');
    const provider = cred.provider as CrmProvider;
    const credentials = cred.credentials as Record<string, string>;

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
      return { success: true };
    } catch (err) {
      const msg = (err as Error).message;
      await this.prisma.workspaceCrmCredential.update({
        where: { id: credentialId },
        data: { status: 'invalid', lastTestedAt: new Date() },
      });
      return { success: false, error: msg };
    }
  }
}
