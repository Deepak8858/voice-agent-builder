import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('webhooks/clerk')
export class ClerkWebhookController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(@Body() body: { type: string; data: Record<string, unknown> }) {
    const { type, data } = body;

    if (type === 'user.created' || type === 'user.updated') {
      await this.prisma.user.upsert({
        where: { id: data.id as string },
        update: {
          email: (data.email_addresses as Array<{ email_address: string }>)?.[0]?.email_address,
          name: (data.first_name as string | undefined) ?? undefined,
        },
        create: {
          id: data.id as string,
          email: (data.email_addresses as Array<{ email_address: string }>)?.[0]?.email_address ?? 'missing',
          name: data.first_name as string | undefined,
        },
      });
    }

    if (type === 'organization.created' || type === 'organization.updated') {
      await this.prisma.organization.upsert({
        where: { id: data.id as string },
        update: { name: data.name as string },
        create: {
          id: data.id as string,
          name: data.name as string,
          slug: (data.slug as string) ?? data.id as string,
          ownerUserId: (data.created_by as string) ?? '00000000-0000-0000-0000-000000000000',
        },
      });
    }

    if (type === 'organizationMembership.created' || type === 'organizationMembership.updated') {
      const membershipId = data.id as string;
      const userId = data.public_user_data?.user_id as string;
      const orgId = data.organization_id as string;
      const role = (data.role as string) ?? 'viewer';
      if (userId && orgId) {
        await this.prisma.membership.upsert({
          where: { userId_workspaceId: { userId, workspaceId: orgId } },
          update: { role },
          create: { id: membershipId, userId, workspaceId: orgId, role },
        });
      }
    }

    return { received: true };
  }
}