import { Body, Controller, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ReminderRequest, ReminderResponse } from '@voiceforge/shared';
import { ReminderRequestSchema } from '@voiceforge/shared';
import { InternalOnly } from '../common/decorators/internal-only.decorator';
import { ForbiddenError } from '../common/errors';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { GoogleCalendarExecutor } from './executors/google-calendar.executor';

/** Reminders are point-in-time; Google needs an end, so every reminder is a 30-minute event. */
const REMINDER_MINUTES = 30;

/**
 * The runtime's implicit `schedule_reminder` tool: a reminder or callback on
 * the connected Google account's primary calendar, titled with the agent's
 * name so every agent's reminders can be told apart in one calendar.
 *
 * `@InternalOnly()` proves the request came from our own runtime; only the
 * call -> agent binding is trusted from the body (the same rule as the tools
 * route), and the workspace comes from the verified call row. Idempotent per
 * call and time, so a retried tool call cannot double-book.
 */
@InternalOnly()
@Controller('internal/runtime/reminders')
export class LiveKitRemindersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: GoogleCalendarExecutor,
  ) {}

  @Post()
  async schedule(
    @Body(new ZodValidationPipe(ReminderRequestSchema)) body: ReminderRequest,
  ): Promise<ReminderResponse> {
    const call = await this.prisma.call.findUnique({
      where: { id: body.callId },
      select: {
        id: true,
        workspaceId: true,
        agentId: true,
        direction: true,
        fromNumber: true,
        toNumber: true,
        agent: { select: { name: true } },
      },
    });
    if (!call || call.agentId !== body.agentId) {
      throw new ForbiddenError('Call is not bound to this agent.');
    }

    const start = new Date(body.when_iso);
    const end = new Date(start.getTime() + REMINDER_MINUTES * 60_000);
    const callerNumber =
      (call.direction === 'outbound' ? call.toNumber : call.fromNumber) ?? 'unknown';
    const result = await this.calendar.execute(
      {
        operation: 'create_event',
        summary: `${call.agent.name}: ${body.title}`,
        start_iso: start.toISOString(),
        end_iso: end.toISOString(),
        time_zone: body.timezone ?? 'UTC',
        description: [body.notes?.trim(), `Caller: ${callerNumber}`, `Call: ${call.id}`]
          .filter(Boolean)
          .join('\n'),
      },
      { calendar_id: 'primary' },
      {
        workspaceId: call.workspaceId,
        idempotencyKey: createHash('sha256')
          .update(`${call.id}:reminder:${start.toISOString()}`)
          .digest('hex'),
      },
    );
    if (!result.success) {
      return { scheduled: false, reason: result.error ?? 'calendar_error', event_link: null };
    }
    const created = (result.result ?? {}) as { html_link?: string | null };
    return { scheduled: true, reason: null, event_link: created.html_link ?? null };
  }
}
