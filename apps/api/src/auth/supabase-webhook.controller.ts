import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

interface SupabaseUserRecord {
  id: string;
  email?: string;
  user_metadata?: {
    full_name?: string;
    name?: string;
  };
  email_confirmed_at?: string | null;
  banned_at?: string | null;
}

interface SupabaseWebhookEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record?: SupabaseUserRecord;
  old_record?: SupabaseUserRecord;
  schema: string;
}

@Controller('webhooks/supabase')
export class SupabaseWebhookController {
  private readonly logger = new Logger(SupabaseWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  @Post()
  @HttpCode(204)
  async receive(@Req() req: Request): Promise<void> {
    const payload = req.body as SupabaseWebhookEvent | SupabaseWebhookEvent[];

    if (Array.isArray(payload)) {
      await Promise.allSettled(payload.map((event) => this.handleEvent(event)));
      return;
    }

    await this.handleEvent(payload);
  }

  private async handleEvent(event: SupabaseWebhookEvent): Promise<void> {
    if (event.table !== 'users' || !['INSERT', 'UPDATE', 'DELETE'].includes(event.type)) {
      this.logger.debug(`Ignoring supabase event: ${event.table}.${event.type}`);
      return;
    }

    if (event.type === 'DELETE') {
      await this.handleDelete(event.old_record as SupabaseUserRecord);
      return;
    }

    await this.handleUpsert(event.record as SupabaseUserRecord);
  }

  private async handleUpsert(record: SupabaseUserRecord): Promise<void> {
    if (!record.id) return;

    // User provisioning is handled by the DB trigger in migration 006.
    // This webhook only handles cache invalidation to keep sessions fresh.
    await this.cache.del(`session:user:${record.id}`);
  }

  private async handleDelete(record: SupabaseUserRecord): Promise<void> {
    if (!record.id) return;
    const user = await this.prisma.user.findUnique({ where: { authUserId: record.id } });
    if (!user) return;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { email: `deleted-${user.id}@voiceforge.local`, name: 'Deleted User', authUserId: null },
    });
    await this.cache.del(`session:user:${record.id}`);
  }
}