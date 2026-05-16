import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

interface ErasureResult {
  success: boolean;
  erasedAt?: string;
  error?: string;
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async eraseContact(workspaceId: string, contactId: string): Promise<ErasureResult> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, workspaceId },
    });
    if (!contact) {
      return { success: false, error: 'Contact not found' };
    }

    // Log before deletion (audit trail)
    await this.audit.log({
      workspaceId,
      action: 'gdpr.contact.erased',
      resourceType: 'contact',
      resourceId: contactId,
      metadata: { contactPhone: contact.phone, erasedAt: new Date().toISOString() },
    });

    // Cascade: contact → consent_records (has cascade), calls (has cascade), compliance_checks (has cascade)
    // Additional: analytics_events, tool_invocations linked to those calls
    const calls = await this.prisma.call.findMany({
      where: { contactId },
      select: { id: true },
    });
    const callIds = calls.map(c => c.id);

    await this.prisma.$transaction(async (tx) => {
      // Delete analytics events for these calls
      if (callIds.length > 0) {
        await tx.analyticsEvent.deleteMany({ where: { callId: { in: callIds } } });
        await tx.callEvaluation.deleteMany({ where: { callId: { in: callIds } } });
        await tx.toolInvocation.deleteMany({ where: { callId: { in: callIds } } });
      }
      // Delete the contact (cascades to consent_records, calls, compliance_checks)
      await tx.contact.delete({ where: { id: contactId } });
    });

    const erasedAt = new Date().toISOString();
    this.logger.log({ contactId, workspaceId }, 'GDPR contact erasure completed');
    return { success: true, erasedAt };
  }

  async eraseOrganization(orgId: string): Promise<ErasureResult> {
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return { success: false, error: 'Organization not found' };

    await this.audit.log({
      action: 'gdpr.organization_deleted',
      resourceType: 'organization',
      resourceId: orgId,
      metadata: { orgName: org.name, erasedAt: new Date().toISOString() },
    });

    await this.prisma.$transaction(async (tx) => {
      // Delete all workspaces (cascade deletes all child data)
      const workspaces = await tx.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } });
      for (const ws of workspaces) {
        await tx.workspace.delete({ where: { id: ws.id } });
      }
      await tx.organization.delete({ where: { id: orgId } });
    });

    const erasedAt = new Date().toISOString();
    this.logger.log({ orgId }, 'GDPR organization erasure completed');
    return { success: true, erasedAt };
  }

  async eraseUser(userId: string): Promise<ErasureResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { success: false, error: 'User not found' };

    await this.audit.log({
      actorUserId: userId,
      action: 'gdpr.user_deleted',
      resourceType: 'user',
      resourceId: userId,
      metadata: { userEmail: user.email, erasedAt: new Date().toISOString() },
    });

    await this.prisma.$transaction(async (tx) => {
      // Delete memberships
      await tx.membership.deleteMany({ where: { userId } });
      await tx.workspaceMembership.deleteMany({ where: { userId } });
      // Delete user
      await tx.user.delete({ where: { id: userId } });
    });

    const erasedAt = new Date().toISOString();
    this.logger.log({ userId }, 'GDPR user erasure completed');
    return { success: true, erasedAt };
  }
}