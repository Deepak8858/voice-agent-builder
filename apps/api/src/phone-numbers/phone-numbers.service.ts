import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { AppError } from '../common/errors';

@Injectable()
export class PhoneNumbersService {
  private readonly logger = new Logger(PhoneNumbersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.twilioPhoneNumber.findMany({
      where: { workspaceId },
      include: { agent: { select: { id: true, name: true } } },
    });
  }

  /**
   * Resolves an agent id within the caller's workspace, or refuses.
   *
   * Every path that writes `agentId` onto a phone number must go through this:
   * an agent id is client-supplied, and a number pointed at another tenant's
   * agent routes that tenant's calls through this workspace's number. The
   * not-found error is deliberately indistinguishable from "no such agent" so
   * the response does not confirm that a foreign agent id exists.
   */
  private async requireWorkspaceAgent(workspaceId: string, agentId: string): Promise<string> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent) throw new AppError('NOT_FOUND', 'Agent not found', 404);
    return agent.id;
  }

  async provision(workspaceId: string, areaCode: string, agentId?: string): Promise<string> {
    // Validated before the search/purchase, and before the credential check,
    // because this is caller input: a rejection after the number is bought
    // would leave a paid-for number stranded on the Twilio account with no
    // local row. Previously `agentId` went straight into `create()` below, so
    // a caller in workspace A could provision a number already pointed at an
    // agent in workspace B.
    if (agentId) await this.requireWorkspaceAgent(workspaceId, agentId);

    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) throw new AppError('TWILIO_NOT_CONFIGURED', 'Twilio credentials not set', 500);

    const searchUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/Local.json`;
    const searchRes = await fetch(`${searchUrl}?AreaCode=${areaCode}&Limit=1`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    });
    const searchData = (await searchRes.json()) as {
      available_phone_numbers?: Array<{ phone_number: string }>;
    };
    const number = searchData.available_phone_numbers?.[0];
    if (!number) throw new AppError('NO_NUMBER_AVAILABLE', `No ${areaCode} numbers available`, 400);

    const purchaseUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`;
    const formData = new URLSearchParams({
      PhoneNumber: number.phone_number,
      VoiceUrl: `${env.TWILIO_TWIML_WEBHOOK_URL}/voice/webhook/inbound`,
      StatusCallback: `${env.TWILIO_STATUS_WEBHOOK_URL}/voice/webhook/status`,
    });

    const purchaseRes = await fetch(purchaseUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!purchaseRes.ok) {
      const text = await purchaseRes.text();
      throw new AppError('TWILIO_PURCHASE_FAILED', `Twilio purchase failed: ${text}`, purchaseRes.status);
    }

    const purchased = (await purchaseRes.json()) as { sid: string; phone_number: string };

    const record = await this.prisma.twilioPhoneNumber.create({
      data: {
        workspaceId,
        agentId: agentId ?? null,
        phoneNumber: purchased.phone_number,
        twilioSid: purchased.sid,
        type: 'local',
        status: 'active',
        inboundWebhookUrl: `${env.TWILIO_TWIML_WEBHOOK_URL}/voice/webhook/inbound`,
        costPerMonth: 1.15,
        provisionedAt: new Date(),
      },
    });

    this.logger.log(`Provisioned ${purchased.phone_number} (${record.id}) for workspace ${workspaceId}`);
    return record.phoneNumber;
  }

  async addByo(workspaceId: string, phoneNumber: string, twilioSid?: string) {
    await this.prisma.twilioPhoneNumber.create({
      data: {
        workspaceId,
        phoneNumber,
        twilioSid,
        type: 'byo',
        status: 'active',
        costPerMonth: 0,
        provisionedAt: new Date(),
      },
    });
  }

  async assignToAgent(
    workspaceId: string,
    numberId: string,
    agentId: string,
    actorUserId?: string | null,
  ) {
    // The agent must also belong to the caller's workspace, otherwise a tenant
    // could point its own number at another tenant's agent.
    await this.requireWorkspaceAgent(workspaceId, agentId);

    const result = await this.prisma.twilioPhoneNumber.updateMany({
      where: { id: numberId, workspaceId },
      data: { agentId },
    });
    if (result.count === 0) throw new AppError('NOT_FOUND', 'Phone number not found', 404);

    // Reassignment reroutes live inbound calls, so the transition needs an
    // audit record. Logged only after the scoped update actually matched a row.
    await this.audit.log({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: 'phone_number.assign',
      resourceType: 'twilio_phone_number',
      resourceId: numberId,
      metadata: { agent_id: agentId },
    });
  }

  async release(workspaceId: string, numberId: string, actorUserId?: string | null) {
    const number = await this.prisma.twilioPhoneNumber.findFirst({
      where: { id: numberId, workspaceId },
    });
    if (!number) return;

    if (number.type !== 'byo' && number.twilioSid) {
      const sid = env.TWILIO_ACCOUNT_SID!;
      const token = env.TWILIO_AUTH_TOKEN!;
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${number.twilioSid}.json`,
        {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
          body: new URLSearchParams({ Status: 'released' }),
        },
      );
    }
    await this.prisma.twilioPhoneNumber.deleteMany({ where: { id: numberId, workspaceId } });

    // Releasing gives the number back to the carrier and drops the local row,
    // so this is the last point at which the number's history can be recorded.
    await this.audit.log({
      workspaceId,
      actorUserId: actorUserId ?? null,
      action: 'phone_number.release',
      resourceType: 'twilio_phone_number',
      resourceId: numberId,
      metadata: {
        phone_number: number.phoneNumber,
        type: number.type,
        previous_agent_id: number.agentId,
      },
    });
  }
}
