import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { PrismaService } from '../prisma/prisma.service';

@Controller('voice/webhook')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly twilioAdapter: TwilioVoiceAdapter,
    private readonly pipeline: VoicePipelineService,
    private readonly sessionManager: CallSessionManager,
    private readonly prisma: PrismaService,
  ) {}

  @Post('inbound')
  @HttpCode(200)
  async handleInbound(@Body() body: Record<string, unknown>) {
    const callSid = body.CallSid as string;
    const from = body.From as string;
    const to = body.To as string;

    this.logger.log(`Inbound call: ${callSid} from ${from} to ${to}`);

    const number = await this.prisma.twilioPhoneNumber.findUnique({
      where: { phoneNumber: to },
      include: { agent: true },
    });

    if (!number?.agent) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No agent configured for this number.</Say></Response>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );
    }

    const call = await this.prisma.call.create({
      data: {
        workspaceId: number.workspaceId!,
        agentId: number.agentId!,
        direction: 'inbound',
        status: 'queued',
        provider: 'twilio',
        providerCallId: callSid,
        fromNumber: from ?? undefined,
        toNumber: to ?? undefined,
      },
    });

    const session = this.sessionManager.create({
      callSid,
      agentId: number.agentId!,
      agentVersionId: number.agent!.activeVersionId ?? '',
      workspaceId: number.workspaceId,
      direction: 'inbound',
      metadata: { callId: call.id },
    });

    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting to ${number.agent!.name}. Please wait.</Say>
  <Stream url="wss://${process.env.WEB_BASE_URL?.replace('https://', '').replace('http://', '')}/voice/stream/${session.id}">
    <Parameter name="workspaceId" value="${number.workspaceId!}"/>
    <Parameter name="agentId" value="${number.agentId!}"/>
  </Stream>
</Response>`,
      { headers: { 'Content-Type': 'text/xml' } },
    );
  }

  @Post('status')
  @HttpCode(200)
  async handleStatus(@Body() body: Record<string, unknown>) {
    await this.twilioAdapter.handleWebhook(body);

    const callSid = body.CallSid as string;
    const status = body.CallStatus as string;

    if (callSid) {
      const call = await this.prisma.call.findFirst({ where: { providerCallId: callSid } });
      if (call) {
        const statusMap: Record<string, string> = {
          queued: 'queued',
          ringing: 'ringing',
          'in-progress': 'in_progress',
          completed: 'completed',
          busy: 'failed',
          failed: 'failed',
          'no-answer': 'failed',
        };
        await this.prisma.call.update({
          where: { id: call.id },
          data: {
            status: statusMap[status] ?? call.status,
            endedAt: status === 'completed' || status === 'failed' ? new Date() : undefined,
          },
        });
      }
    }

    return '';
  }
}
