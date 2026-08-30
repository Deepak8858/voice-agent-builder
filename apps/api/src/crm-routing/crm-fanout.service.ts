import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CrmRoutingService, type FanOutResult } from './crm-routing.service';
import { CrmExecutor, type CrmContactArgs } from '../tools/crm-executor';
import type { CrmProvider } from '../tools/crm-executor';
import { AppError } from '../common/errors';
import { EncryptionService } from '../security/encryption.service';

@Injectable()
export class CrmFanOutService {
  private readonly logger = new Logger(CrmFanOutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: CrmRoutingService,
    private readonly crmExecutor: CrmExecutor,
    private readonly encryption: EncryptionService,
  ) {}

  async fanOutContact(
    workspaceId: string,
    agentId: string,
    callId: string,
    contactData: CrmContactArgs,
  ): Promise<FanOutResult> {
    const call = await this.prisma.call.findFirst({ where: { id: callId, workspaceId } });
    const transcript = call?.transcriptText ?? '';
    const rules = await this.routing.findMatchingRules(workspaceId, agentId, transcript);

    if (rules.length === 0) {
      return { primary: null, secondary: [], errors: ['No matching CRM routing rules'] };
    }

    const result: FanOutResult = { primary: null, secondary: [], errors: [] };
    const primaryRule = rules.find(r => r.action === 'primary');
    const secondaryRules = rules.filter(r => r.action === 'secondary');

    if (primaryRule) {
      const creds = await this.getCrmCredentials(workspaceId, primaryRule.provider);
      if (creds) {
        try {
          const res = await this.crmExecutor.createContact(
            this.executorProvider(primaryRule.provider),
            creds,
            contactData,
          );
          result.primary = { provider: primaryRule.provider, contact_id: res.contact_id, status: res.status };
        } catch (err) {
          result.errors.push(`Primary CRM (${primaryRule.provider}) failed: ${(err as Error).message}`);
        }
      } else {
        result.errors.push(`No credentials for primary CRM: ${primaryRule.provider}`);
      }
    }

    for (const rule of secondaryRules) {
      const creds = await this.getCrmCredentials(workspaceId, rule.provider);
      if (!creds) {
        result.secondary.push({ provider: rule.provider, contact_id: '', status: 'skipped', error: 'No credentials' });
        continue;
      }
      try {
        const res = await this.crmExecutor.createContact(
          this.executorProvider(rule.provider),
          creds,
          contactData,
        );
        result.secondary.push({ provider: rule.provider, contact_id: res.contact_id, status: res.status });
      } catch (err) {
        result.secondary.push({ provider: rule.provider, contact_id: '', status: 'failed', error: (err as Error).message });
      }
    }

    await this.prisma.crmFanoutLog.create({
      data: {
        workspaceId,
        callId,
        agentId,
        contactData: contactData as object,
        fanoutResults: result as object,
      },
    });

    return result;
  }

  private async getCrmCredentials(workspaceId: string, provider: string) {
    const cred = await this.prisma.workspaceCrmCredential.findUnique({
      where: { workspaceId_provider: { workspaceId, provider } },
    });
    if (!cred || cred.status !== 'active') return null;
    return this.readCredentials(cred.credentials);
  }

  private executorProvider(provider: string): CrmProvider {
    return provider === 'generic_webhook' ? 'generic' : (provider as CrmProvider);
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

  private isEncryptedEnvelope(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as Record<string, unknown>;
    return maybe.v === 1 && maybe.alg === 'aes-256-gcm';
  }
}
