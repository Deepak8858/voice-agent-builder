import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import type {
  ClientInvite,
  ClientUsage,
  ClientWorkspace,
  CreateClientInviteDto,
  CreateClientWorkspaceDto,
  UpdateWhiteLabelSettingsDto,
  WhiteLabelSettings,
} from '@voiceforge/shared';
import { SUCCESS_OUTCOMES } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { AppError, ForbiddenError, ValidationError } from '../common/errors';

const DEFAULT_USAGE_WINDOW_DAYS = 30;
const DEFAULT_INVITE_EXPIRY_DAYS = 14;

@Injectable()
export class WhiteLabelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {}

  // --- settings -------------------------------------------------------

  async getSettings(workspaceId: string): Promise<WhiteLabelSettings> {
    const row = await this.prisma.whiteLabelSettings.findUnique({
      where: { workspaceId },
    });
    if (!row) return this.emptySettings(workspaceId);
    return this.toSettingsDto(row);
  }

  async updateSettings(
    workspaceId: string,
    actorUserId: string,
    dto: UpdateWhiteLabelSettingsDto,
  ): Promise<WhiteLabelSettings> {
    if (dto.custom_domain) {
      const conflict = await this.prisma.whiteLabelSettings.findUnique({
        where: { customDomain: dto.custom_domain },
      });
      if (conflict && conflict.workspaceId !== workspaceId) {
        throw new ValidationError('Custom domain already in use by another workspace.', {
          custom_domain: dto.custom_domain,
        });
      }
    }

    const data: Prisma.WhiteLabelSettingsUncheckedCreateInput = {
      workspaceId,
      brandName: dto.brand_name ?? null,
      logoUrl: dto.logo_url ?? null,
      primaryColor: dto.primary_color ?? null,
      customDomain: dto.custom_domain ?? null,
      supportEmail: dto.support_email ?? null,
      hidePlatformBranding: dto.hide_platform_branding ?? false,
    };
    const update: Prisma.WhiteLabelSettingsUncheckedUpdateInput = {};
    if ('brand_name' in dto) update.brandName = dto.brand_name ?? null;
    if ('logo_url' in dto) update.logoUrl = dto.logo_url ?? null;
    if ('primary_color' in dto) update.primaryColor = dto.primary_color ?? null;
    if ('custom_domain' in dto) update.customDomain = dto.custom_domain ?? null;
    if ('support_email' in dto) update.supportEmail = dto.support_email ?? null;
    if ('hide_platform_branding' in dto)
      update.hidePlatformBranding = dto.hide_platform_branding ?? false;

    const row = await this.prisma.whiteLabelSettings.upsert({
      where: { workspaceId },
      create: data,
      update,
    });

    await this.audit.log({
      workspaceId,
      actorUserId,
      action: 'white_label.update',
      resourceType: 'white_label_settings',
      resourceId: row.id,
      metadata: dto as Record<string, unknown>,
    });

    return this.toSettingsDto(row);
  }

  // --- client workspaces ---------------------------------------------

  /**
   * List all agents across all client workspaces of an agency. Allows agency
   * owners to see what every client has built without switching workspaces.
   */
  async listAgencyAgents(agencyWorkspaceId: string): Promise<
    Array<{
      agent_id: string;
      agent_name: string;
      agent_status: string;
      agent_type: string;
      industry: string;
      client_workspace_id: string;
      client_workspace_name: string;
      created_at: string;
      updated_at: string;
    }>
  > {
    const agency = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: agencyWorkspaceId },
      select: { type: true },
    });
    if (agency.type !== 'agency' && agency.type !== 'direct') {
      throw new ForbiddenError('Workspace is not an agency.');
    }
    const rows = await this.prisma.agent.findMany({
      where: { workspace: { parentWorkspaceId: agencyWorkspaceId, type: 'client' } },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => ({
      agent_id: r.id,
      agent_name: r.name,
      agent_status: r.status,
      agent_type: r.agentType,
      industry: r.industry,
      client_workspace_id: r.workspace.id,
      client_workspace_name: r.workspace.name,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }));
  }

  async listClients(agencyWorkspaceId: string): Promise<ClientWorkspace[]> {
    const agency = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: agencyWorkspaceId },
      select: { id: true, type: true },
    });
    if (agency.type !== 'agency' && agency.type !== 'direct') {
      // direct workspaces also allowed to host children for upgrade path
      throw new ForbiddenError('Workspace is not an agency.');
    }
    const rows = await this.prisma.workspace.findMany({
      where: { parentWorkspaceId: agencyWorkspaceId, type: 'client' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        parentWorkspaceId: true,
        name: true,
        slug: true,
        status: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      parent_workspace_id: r.parentWorkspaceId!,
      name: r.name,
      slug: r.slug,
      status: r.status,
      created_at: r.createdAt.toISOString(),
    }));
  }

  async createClient(
    agencyWorkspaceId: string,
    actorUserId: string,
    dto: CreateClientWorkspaceDto,
  ): Promise<ClientWorkspace> {
    const agency = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: agencyWorkspaceId },
    });

    // unique per organization
    const conflict = await this.prisma.workspace.findUnique({
      where: {
        organizationId_slug: { organizationId: agency.organizationId, slug: dto.slug },
      },
    });
    if (conflict) {
      throw new ValidationError('A workspace with this slug already exists.', {
        slug: dto.slug,
      });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // Promote the parent to "agency" if it was direct.
      if (agency.type === 'direct') {
        await tx.workspace.update({
          where: { id: agency.id },
          data: { type: 'agency' },
        });
      }

      const child = await tx.workspace.create({
        data: {
          organizationId: agency.organizationId,
          parentWorkspaceId: agency.id,
          type: 'client',
          name: dto.name,
          slug: dto.slug,
          status: 'active',
        },
      });

      // Owner: actor inherits owner role on the new client workspace.
      await tx.membership.create({
        data: {
          userId: actorUserId,
          workspaceId: child.id,
          role: 'owner',
        },
      });

      return child;
    });

    await this.audit.log({
      workspaceId: agencyWorkspaceId,
      actorUserId,
      action: 'client_workspace.create',
      resourceType: 'workspace',
      resourceId: created.id,
      metadata: { name: dto.name, slug: dto.slug },
    });

    return {
      id: created.id,
      parent_workspace_id: agencyWorkspaceId,
      name: created.name,
      slug: created.slug,
      status: created.status,
      created_at: created.createdAt.toISOString(),
    };
  }

  async clientUsage(
    agencyWorkspaceId: string,
    clientWorkspaceId: string,
  ): Promise<ClientUsage> {
    const child = await this.prisma.workspace.findUnique({
      where: { id: clientWorkspaceId },
    });
    if (!child || child.parentWorkspaceId !== agencyWorkspaceId) {
      throw new AppError(
        'NOT_FOUND',
        `Client workspace ${clientWorkspaceId} not found under this agency.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const to = new Date();
    const from = new Date(to.getTime() - DEFAULT_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const calls = await this.prisma.call.findMany({
      where: { workspaceId: clientWorkspaceId, createdAt: { gte: from, lte: to } },
      select: { durationSeconds: true, agentId: true, outcome: true },
    });
    const blocked = await this.prisma.complianceCheck.count({
      where: {
        workspaceId: clientWorkspaceId,
        status: 'blocked',
        checkedAt: { gte: from, lte: to },
      },
    });
    const totalSeconds = calls.reduce((s, c) => s + (c.durationSeconds ?? 0), 0);
    const activeAgents = new Set(calls.map((c) => c.agentId)).size;

    return {
      workspace_id: clientWorkspaceId,
      range: { from: from.toISOString(), to: to.toISOString() },
      total_calls: calls.length,
      total_minutes: Math.round((totalSeconds / 60) * 100) / 100,
      blocked_calls: blocked,
      active_agents: activeAgents,
    };
  }

  // --- invites -------------------------------------------------------

  async listInvites(agencyWorkspaceId: string): Promise<ClientInvite[]> {
    const rows = await this.prisma.clientInvite.findMany({
      where: { agencyWorkspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toInviteDto(r));
  }

  async createInvite(
    agencyWorkspaceId: string,
    actorUserId: string,
    dto: CreateClientInviteDto,
  ): Promise<ClientInvite> {
    if (dto.client_workspace_id) {
      const child = await this.prisma.workspace.findUnique({
        where: { id: dto.client_workspace_id },
        select: { parentWorkspaceId: true },
      });
      if (!child || child.parentWorkspaceId !== agencyWorkspaceId) {
        throw new ValidationError('client_workspace_id is not a child of this agency.');
      }
    }

    const expiryDays = dto.expires_in_days ?? DEFAULT_INVITE_EXPIRY_DAYS;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    const token = randomBytes(24).toString('hex');

    const row = await this.prisma.clientInvite.create({
      data: {
        agencyWorkspaceId,
        clientWorkspaceId: dto.client_workspace_id ?? null,
        email: dto.email,
        role: dto.role ?? 'admin',
        token,
        status: 'pending',
        expiresAt,
        invitedBy: actorUserId,
      },
    });

    await this.audit.log({
      workspaceId: agencyWorkspaceId,
      actorUserId,
      action: 'client_invite.create',
      resourceType: 'client_invite',
      resourceId: row.id,
      metadata: { email: dto.email, role: row.role },
    });

    // Best-effort email send. If RESEND_API_KEY is unset the service logs a
    // warning and returns delivered:false; the token still appears in the
    // response so the agency can copy/paste in dev.
    try {
      const branding = await this.prisma.whiteLabelSettings.findUnique({
        where: { workspaceId: agencyWorkspaceId },
      });
      const inviter = await this.prisma.user.findUnique({
        where: { id: actorUserId },
        select: { name: true, email: true },
      });
      await this.email.sendInvite({
        to: dto.email,
        inviteToken: token,
        role: row.role,
        brandName: branding?.brandName ?? null,
        brandLogoUrl: branding?.logoUrl ?? null,
        primaryColor: branding?.primaryColor ?? null,
        inviterName: inviter?.name ?? inviter?.email ?? null,
        expiresAt: row.expiresAt,
      });
    } catch {
      // Email delivery must never break invite creation.
    }

    return this.toInviteDto(row);
  }

  async revokeInvite(
    agencyWorkspaceId: string,
    actorUserId: string,
    inviteId: string,
  ): Promise<ClientInvite> {
    const existing = await this.prisma.clientInvite.findUnique({
      where: { id: inviteId },
    });
    if (!existing || existing.agencyWorkspaceId !== agencyWorkspaceId) {
      throw new AppError(
        'NOT_FOUND',
        `Invite ${inviteId} not found.`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.status !== 'pending') {
      throw new ValidationError(
        `Cannot revoke an invite with status "${existing.status}".`,
      );
    }
    const updated = await this.prisma.clientInvite.update({
      where: { id: inviteId },
      data: { status: 'revoked' },
    });
    await this.audit.log({
      workspaceId: agencyWorkspaceId,
      actorUserId,
      action: 'client_invite.revoke',
      resourceType: 'client_invite',
      resourceId: inviteId,
    });
    return this.toInviteDto(updated);
  }

  async acceptInvite(
    actorUserId: string,
    token: string,
  ): Promise<ClientInvite> {
    const invite = await this.prisma.clientInvite.findUnique({ where: { token } });
    if (!invite) {
      throw new AppError('NOT_FOUND', 'Invite token not found.', HttpStatus.NOT_FOUND);
    }
    if (invite.status !== 'pending') {
      throw new ValidationError(`Invite already ${invite.status}.`);
    }
    if (invite.expiresAt.getTime() < Date.now()) {
      await this.prisma.clientInvite.update({
        where: { id: invite.id },
        data: { status: 'expired' },
      });
      throw new ValidationError('Invite has expired.');
    }
    if (!invite.clientWorkspaceId) {
      throw new ValidationError('Invite is not bound to a client workspace yet.');
    }

    const accepted = await this.prisma.$transaction(async (tx) => {
      await tx.membership.upsert({
        where: {
          userId_workspaceId: {
            userId: actorUserId,
            workspaceId: invite.clientWorkspaceId!,
          },
        },
        update: { role: invite.role },
        create: {
          userId: actorUserId,
          workspaceId: invite.clientWorkspaceId!,
          role: invite.role,
        },
      });
      return tx.clientInvite.update({
        where: { id: invite.id },
        data: { status: 'accepted', acceptedAt: new Date() },
      });
    });

    await this.audit.log({
      workspaceId: invite.agencyWorkspaceId,
      actorUserId,
      action: 'client_invite.accept',
      resourceType: 'client_invite',
      resourceId: invite.id,
    });

    return this.toInviteDto(accepted);
  }

  // --- helpers --------------------------------------------------------

  private toSettingsDto(row: {
    workspaceId: string;
    brandName: string | null;
    logoUrl: string | null;
    primaryColor: string | null;
    customDomain: string | null;
    supportEmail: string | null;
    hidePlatformBranding: boolean;
    updatedAt: Date;
  }): WhiteLabelSettings {
    return {
      workspace_id: row.workspaceId,
      brand_name: row.brandName,
      logo_url: row.logoUrl,
      primary_color: row.primaryColor,
      custom_domain: row.customDomain,
      support_email: row.supportEmail,
      hide_platform_branding: row.hidePlatformBranding,
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private emptySettings(workspaceId: string): WhiteLabelSettings {
    return {
      workspace_id: workspaceId,
      brand_name: null,
      logo_url: null,
      primary_color: null,
      custom_domain: null,
      support_email: null,
      hide_platform_branding: false,
      updated_at: new Date(0).toISOString(),
    };
  }

  private toInviteDto(row: {
    id: string;
    agencyWorkspaceId: string;
    clientWorkspaceId: string | null;
    email: string;
    role: string;
    token: string;
    status: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    createdAt: Date;
  }): ClientInvite {
    return {
      id: row.id,
      agency_workspace_id: row.agencyWorkspaceId,
      client_workspace_id: row.clientWorkspaceId,
      email: row.email,
      role: row.role as 'admin' | 'viewer',
      token: row.token,
      status: row.status as 'pending' | 'accepted' | 'revoked' | 'expired',
      expires_at: row.expiresAt.toISOString(),
      accepted_at: row.acceptedAt ? row.acceptedAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
    };
  }
}
