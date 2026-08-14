import { Controller, Post, Body, HttpCode, Logger } from '@nestjs/common';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { CallAdmissionService } from '../billing/call-admission.service';
import { PrismaService } from '../prisma/prisma.service';

const BILLING_REFUSAL_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this number cannot take calls right now. Please try again later.</Say><Hangup/></Response>';

@Controller('voice/webhook')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly twilioAdapter: TwilioVoiceAdapter,
    private readonly pipeline: VoicePipelineService,
    private readonly sessionManager: CallSessionManager,
    private readonly prisma: PrismaService,
    private readonly admission: CallAdmissionService,
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
      include: {
        agent: true,
        workspace: { select: { organizationId: true } },
      },
    });

    if (!number?.agent) {
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No agent configured for this number.</Say></Response>`,
        { headers: { 'Content-Type': 'text/xml' } },
      );
    }

    // Twilio retries this webhook, so the call is looked up before it is
    // created: a retry must reuse the admitted call rather than open a second
    // one that would consume another concurrency slot and another minute.
    const call =
      (await this.prisma.call.findFirst({ where: { providerCallId: callSid } })) ??
      (await this.prisma.call.create({
        data: {
          workspaceId: number.workspaceId!,
          organizationId: number.workspace.organizationId,
          agentId: number.agentId!,
          direction: 'inbound',
          status: 'queued',
          provider: 'twilio',
          providerCallId: callSid,
          fromNumber: from ?? undefined,
          toNumber: to ?? undefined,
        },
      }));

    // The media stream below is billable the moment Twilio opens it, so nothing
    // is streamed until billing has admitted the call.
    if (!(await this.admitInbound(call.id, number.workspaceId!, number.workspace.organizationId, callSid))) {
      await this.prisma.call.update({
        where: { id: call.id },
        data: { status: 'failed', endedAt: new Date(), outcome: 'billing_denied' },
      });
      return new Response(BILLING_REFUSAL_TWIML, { headers: { 'Content-Type': 'text/xml' } });
    }

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

  /**
   * Admits an inbound call once. The usage record written by a successful
   * admission is the marker that this call is already paid for, so a retried
   * webhook is let through without acquiring a second lease or reserving a
   * second minute.
   */
  private async admitInbound(
    callId: string,
    workspaceId: string,
    organizationId: string,
    providerCallId: string,
  ): Promise<boolean> {
    const existingUsage = await this.prisma.callUsage.findUnique({
      where: { callId },
      select: { id: true },
    });
    if (existingUsage) return true;

    const admission = await this.admission.admitCall({
      organizationId,
      workspaceId,
      callId,
      provider: 'twilio',
      direction: 'inbound',
      providerCallId,
    });
    return admission.admitted;
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
