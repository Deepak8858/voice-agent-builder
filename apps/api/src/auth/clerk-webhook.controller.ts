import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

interface ClerkEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp?: number;
}

interface ClerkUserData {
  id: string;
  email_addresses?: Array<{ email_address: string; id: string }>;
  primary_email_address_id?: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
}

interface ClerkOrgData {
  id: string;
  name?: string;
  slug?: string;
}

interface ClerkOrgMembershipData {
  id: string;
  organization: ClerkOrgData;
  public_user_data?: { user_id: string };
  role?: string;
}

@Controller('webhooks/clerk')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(204)
  async receive(
    @Headers() headers: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<void> {
    if (!env.CLERK_WEBHOOK_SECRET) {
      if (env.NODE_ENV === 'production') {
        throw new UnauthorizedException('Clerk webhook not configured');
      }
      this.logger.warn('CLERK_WEBHOOK_SECRET not set; allowing webhook in non-production mode.');
    }

    const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(req.body ?? {});

    let event: ClerkEvent;
    if (env.CLERK_WEBHOOK_SECRET) {
      try {
        // svix verifies the `svix-id`, `svix-timestamp`, `svix-signature` headers.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Webhook } = require('svix') as typeof import('svix');
        const wh = new Webhook(env.CLERK_WEBHOOK_SECRET);
        event = wh.verify(rawBody, {
          'svix-id': headers['svix-id'],
          'svix-timestamp': headers['svix-timestamp'],
          'svix-signature': headers['svix-signature'],
        }) as ClerkEvent;
      } catch (err) {
        this.logger.warn(`Clerk webhook signature invalid: ${(err as Error).message}`);
        await this.audit.log({
          workspaceId: null,
          actorUserId: null,
          action: 'clerk.webhook.rejected',
          resourceType: 'clerk_webhook',
          metadata: { reason: 'invalid_signature' },
        });
        throw new UnauthorizedException('Invalid webhook signature');
      }
    } else {
      try {
        event = JSON.parse(rawBody) as ClerkEvent;
      } catch {
        throw new BadRequestException('Invalid JSON payload');
      }
    }

    await this.handle(event);
  }

  private async handle(event: ClerkEvent): Promise<void> {
    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await this.upsertUser(event.data as unknown as ClerkUserData);
        break;
      case 'user.deleted':
        await this.deleteUser(event.data as unknown as { id: string });
        break;
      case 'organization.created':
      case 'organization.updated':
        await this.upsertOrg(event.data as unknown as ClerkOrgData);
        break;
      case 'organization.deleted':
        await this.deleteOrg(event.data as unknown as { id: string });
        break;
      case 'organizationMembership.created':
      case 'organizationMembership.updated':
        await this.upsertMembership(event.data as unknown as ClerkOrgMembershipData);
        break;
      default:
        this.logger.debug(`Ignoring Clerk event ${event.type}`);
    }
  }

  private async upsertUser(data: ClerkUserData): Promise<void> {
    const externalAuthId = data.id;
    const email =
      data.email_addresses?.find((e) => e.id === data.primary_email_address_id)?.email_address ??
      data.email_addresses?.[0]?.email_address ??
      null;
    if (!email) return;
    const name =
      [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || null;

    await this.prisma.user.upsert({
      where: { externalAuthId },
      create: { externalAuthId, email, name },
      update: { email, name },
    });
  }

  private async deleteUser(data: { id: string }): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { externalAuthId: data.id } });
    if (!user) return;
    await this.prisma.user.delete({ where: { id: user.id } });
  }

  private async upsertOrg(data: ClerkOrgData): Promise<void> {
    if (!data.id || !data.slug) return;
    await this.prisma.organization.upsert({
      where: { slug: data.slug },
      create: { slug: data.slug, name: data.name ?? data.slug, ownerUserId: '' },
      update: { name: data.name ?? data.slug },
    });
  }

  private async deleteOrg(data: { id: string }): Promise<void> {
    // Clerk org IDs aren't directly stored; orgs are linked via slug.
    // Best-effort: nothing to delete here without a slug, so skip.
    this.logger.debug(`Clerk org delete received for ${data.id}; no slug-based mapping, skipping.`);
  }

  private async upsertMembership(data: ClerkOrgMembershipData): Promise<void> {
    const orgSlug = data.organization?.slug;
    const externalAuthId = data.public_user_data?.user_id;
    if (!orgSlug || !externalAuthId) return;

    const org = await this.prisma.organization.findUnique({ where: { slug: orgSlug } });
    const user = await this.prisma.user.findUnique({ where: { externalAuthId } });
    if (!org || !user) return;

    const workspace = await this.prisma.workspace.findFirst({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'asc' },
    });
    if (!workspace) return;

    await this.prisma.membership.upsert({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      create: {
        userId: user.id,
        workspaceId: workspace.id,
        role: (data.role ?? 'member').replace('org:', ''),
      },
      update: { role: (data.role ?? 'member').replace('org:', '') },
    });
  }
}
