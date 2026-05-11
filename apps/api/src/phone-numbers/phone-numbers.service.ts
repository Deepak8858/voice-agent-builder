import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { env } from '../config/env';
import { AppError } from '../common/errors';

@Injectable()
export class PhoneNumbersService {
  private readonly logger = new Logger(PhoneNumbersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string) {
    return this.prisma.twilioPhoneNumber.findMany({
      where: { workspaceId },
      include: { agent: { select: { id: true, name: true } } },
    });
  }

  async provision(workspaceId: string, areaCode: string, agentId?: string): Promise<string> {
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

  async assignToAgent(numberId: string, agentId: string) {
    await this.prisma.twilioPhoneNumber.update({ where: { id: numberId }, data: { agentId } });
  }

  async release(numberId: string) {
    const number = await this.prisma.twilioPhoneNumber.findUnique({ where: { id: numberId } });
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
    await this.prisma.twilioPhoneNumber.delete({ where: { id: numberId } });
  }
}
