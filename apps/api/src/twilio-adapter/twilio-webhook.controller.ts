import { Controller, Post, Body, Headers, HttpCode, Logger, Req } from '@nestjs/common';
import type { Request } from 'express';
import { TwilioVoiceAdapter } from './twilio.adapter';
import { VoicePipelineService } from './voice-pipeline.service';
import { CallSessionManager } from './call-session-manager';
import { TwilioSignatureVerifier } from './twilio-signature.verifier';
import { CallAdmissionService } from '../billing/call-admission.service';
import { PrismaService } from '../prisma/prisma.service';

const BILLING_REFUSAL_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this number cannot take calls right now. Please try again later.</Say><Hangup/></Response>';

/** Prisma reports a unique-index rejection as `P2002`. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002';
}

@Controller('voice/webhook')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly twilioAdapter: TwilioVoiceAdapter,
    private readonly pipeline: VoicePipelineService,
    private readonly sessionManager: CallSessionManager,
    private readonly prisma: PrismaService,
    private readonly admission: CallAdmissionService,
    private readonly signatures: TwilioSignatureVerifier,
  ) {}

  @Post('inbound')
  @HttpCode(200)
  async handleInbound(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined> = {},
    @Req() req?: Request,
  ) {
    // Nothing below this line may run for an unauthenticated caller: the
    // handler creates a call, spends billing credit, and opens a media stream,
    // all of which an unsigned request could otherwise trigger at will.
    await this.signatures.assertValidSignature(
      { headers, originalUrl: requestUrl(req, '/voice/webhook/inbound'), body },
      'voice.inbound',
    );

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

    // The provider-scoped unique key makes concurrent Twilio retries collapse
    // into one call. Returning the persisted row also lets us fail closed if a
    // provider identifier is ever replayed against another tenant or number.
    const identity = { provider: 'twilio', providerCallId: callSid };
    let call;
    try {
      call = await this.prisma.call.upsert({
        where: { provider_providerCallId: identity },
        create: {
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
        update: {},
      });
    } catch (err) {
      // An empty `update` is not lowered to a native `INSERT ... ON CONFLICT`,
      // so a simultaneous retry surfaces as `P2002` rather than being absorbed.
      // The winner's row is authoritative, so it is read back instead of
      // creating a second call for the same provider identifier.
      if (!isUniqueConstraintViolation(err)) throw err;
      call = await this.prisma.call.findUnique({ where: { provider_providerCallId: identity } });
      if (!call) {
        this.logger.error(`Twilio call ${callSid} could not be resolved after a unique conflict`);
        return new Response(BILLING_REFUSAL_TWIML, { headers: { 'Content-Type': 'text/xml' } });
      }
    }
    if (
      call.workspaceId !== number.workspaceId ||
      call.organizationId !== number.workspace.organizationId ||
      call.agentId !== number.agentId
    ) {
      this.logger.error(`Twilio call identity collision for ${callSid}`);
      return new Response(BILLING_REFUSAL_TWIML, { headers: { 'Content-Type': 'text/xml' } });
    }

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
      select: { finalizationState: true },
    });
    if (existingUsage && existingUsage.finalizationState !== 'finalized') return true;

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
  async handleStatus(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string | string[] | undefined> = {},
    @Req() req?: Request,
  ) {
    // Status callbacks mutate call state, so they are authenticated on the
    // same terms as the inbound webhook.
    await this.signatures.assertValidSignature(
      { headers, originalUrl: requestUrl(req, '/voice/webhook/status'), body },
      'voice.status',
    );

    await this.twilioAdapter.handleWebhook(body);

    const callSid = body.CallSid as string;
    const status = body.CallStatus as string;

    if (callSid) {
      const call = await this.prisma.call.findUnique({
        where: { provider_providerCallId: { provider: 'twilio', providerCallId: callSid } },
      });
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

/**
 * The path Twilio signed. Only the path and query are taken from the request;
 * the origin is supplied by the verifier from configuration so a forged `Host`
 * header cannot influence the string that is hashed.
 */
function requestUrl(req: Request | undefined, fallbackPath: string): string {
  return req?.originalUrl ?? req?.url ?? fallbackPath;
}
