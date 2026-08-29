import { Injectable, Logger } from '@nestjs/common';
import type { FeatureGate } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BillingService, ForbiddenPlanError } from '../billing/billing.service';
import { env } from '../config/env';
import { AppError } from '../common/errors';
import type { AddByoPhoneNumberDto, ProvisionPhoneNumberDto } from './phone-numbers.schemas';

const BILLING_UPGRADE_PATH = '/dashboard/billing';

/**
 * Same wording TelephonyService.assertByoTelephonyAllowed uses, because this is
 * the same capability on a second route: a workspace refused there must be
 * refused here for the same stated reason.
 */
const BYO_TELEPHONY_REFUSAL =
  'BYO phone numbers and GPT Realtime calling require a paid plan. Free workspaces can use the VoiceForge voice pipeline only.';

@Injectable()
export class PhoneNumbersService {
  private readonly logger = new Logger(PhoneNumbersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // Optional in arity only, so the two suites that build this service by hand
    // (security/cross-tenant-isolation, audit/critical-mutation-audit) keep
    // compiling. Nest resolves it on every real instance because
    // PhoneNumbersModule imports BillingModule, and assertPlanAllows fails
    // closed if it is ever absent: an unavailable gate is not an open one.
    private readonly billing?: BillingService,
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

  /**
   * Plan gate for the paid telephony capability behind this controller.
   *
   * Both write paths hand the workspace real PSTN capability - `provision` by
   * spending money on a carrier number, `addByo` by binding a number the caller
   * claims to own - and neither consulted a plan before this. The refusal
   * mirrors TelephonyService.assertByoTelephonyAllowed exactly, so the upgrade
   * modal reads the same `limitType` whichever surface refused.
   */
  private async assertPlanAllows(
    workspaceId: string,
    gate: FeatureGate,
    message: string,
  ): Promise<void> {
    if (!this.billing) {
      throw new AppError('BILLING_UNAVAILABLE', 'Plan entitlements are unavailable.', 503);
    }
    const workspace = await this.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const allowed = await this.billing.checkFeatureGate(workspace.organizationId, gate);
    if (!allowed) {
      throw new ForbiddenPlanError(message, {
        limitType: gate,
        currentPlan: 'free',
        upgradePath: BILLING_UPGRADE_PATH,
      });
    }
  }

  /**
   * Hands a number back to Twilio, or throws.
   *
   * `DELETE` on the instance resource is the only call that releases a number.
   * This used to be `POST` with `Status=released`, which is not a parameter
   * Twilio's IncomingPhoneNumbers resource accepts: Twilio ignored it, answered
   * 200, and kept billing the number every month while the local row was
   * deleted. The response was never read either, so a 401 from missing
   * credentials looked identical to success.
   *
   * 404 is treated as done: the number is already off the account, which is the
   * outcome the caller asked for.
   */
  private async releaseFromTwilio(twilioSid: string): Promise<void> {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new AppError('TWILIO_NOT_CONFIGURED', 'Twilio credentials not set', 500);
    }

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${twilioSid}.json`,
      {
        method: 'DELETE',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
      },
    );
    if (!res.ok && res.status !== 404) {
      throw new AppError(
        'VOICE_PROVIDER_ERROR',
        `Twilio refused to release ${twilioSid} (HTTP ${res.status})`,
        502,
      );
    }
  }

  /**
   * Parameter types are read off the zod-inferred DTO rather than written out as
   * `string`. CI compiles with `strict: false`, under which `z.infer` reports
   * every property as optional, so a hand-written required parameter cannot be
   * satisfied by the validated body the controller passes in.
   */
  async provision(
    workspaceId: string,
    areaCode: ProvisionPhoneNumberDto['area_code'],
    agentId?: ProvisionPhoneNumberDto['agent_id'],
  ): Promise<string> {
    // Validated before the search/purchase, and before the credential check,
    // because this is caller input: a rejection after the number is bought
    // would leave a paid-for number stranded on the Twilio account with no
    // local row. Previously `agentId` went straight into `create()` below, so
    // a caller in workspace A could provision a number already pointed at an
    // agent in workspace B.
    if (agentId) await this.requireWorkspaceAgent(workspaceId, agentId);

    // Before the credential check and long before the purchase: this route buys
    // a number on VoiceForge's own Twilio account, so a plan that is not paying
    // for PSTN must be refused before any money leaves. `managed_telephony`
    // rather than `outbound` because the two answer different questions and the
    // refusal's `limitType` is customer-visible: this is a recurring carrier
    // rental on the platform's card, not permission to dial out.
    await this.assertPlanAllows(
      workspaceId,
      'managed_telephony',
      'Provisioning a phone number requires a paid plan.',
    );

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
    if (!number)
      throw new AppError('NO_NUMBER_AVAILABLE', `No ${areaCode} numbers available`, 400);

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

    let record;
    try {
      record = await this.prisma.twilioPhoneNumber.create({
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
    } catch (err) {
      // The number is bought and billing by this point. Hand it back before
      // surfacing the failure: without this, a failed insert (a duplicate
      // `phoneNumber`, a dropped connection) leaves a number billing monthly on
      // our Twilio account with no local row to find it by. That is the same
      // stranding the agentId check above exists to avoid, applied to the write
      // itself rather than only to the validation before it.
      await this.releaseFromTwilio(purchased.sid).catch((releaseErr: unknown) => {
        this.logger.error(
          `Orphaned Twilio number ${purchased.phone_number} (${purchased.sid}) for workspace ` +
            `${workspaceId}: the release after a failed create also failed`,
          releaseErr instanceof Error ? releaseErr.stack : String(releaseErr),
        );
      });
      throw err;
    }

    this.logger.log(`Provisioned ${purchased.phone_number} (${record.id}) for workspace ${workspaceId}`);
    return record.phoneNumber;
  }

  /**
   * Registers a number the workspace already owns.
   *
   * This spends nothing, which is exactly why it went ungated: it looks like a
   * bookkeeping write. It is in fact a second door to the paid BYO capability
   * that TelephonyService gates, and it was open on every plan.
   *
   * Ownership is still not *proven*. Nothing in the request ties the number to a
   * Twilio account this API can query, so a first mover can pre-claim a number
   * it does not own; `phoneNumber` is uniquely indexed, so that claim then
   * permanently denies the rightful owner (release requires membership of the
   * holding workspace, and there is no operator override). Because the inbound
   * webhook resolves calls by `phoneNumber` alone, inbound calls to that number
   * would land in the squatter's workspace. Closing that needs a verification
   * step and a place to record the pending state - see the report; it cannot be
   * done from this method alone.
   */
  async addByo(
    workspaceId: string,
    phoneNumber: AddByoPhoneNumberDto['phone_number'],
    twilioSid?: AddByoPhoneNumberDto['twilio_sid'],
  ) {
    await this.assertPlanAllows(workspaceId, 'byo_telephony', BYO_TELEPHONY_REFUSAL);

    try {
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
    } catch (err) {
      // Prisma reports the unique index on `phoneNumber` as P2002. Surfaced as a
      // 409 rather than a 500, and deliberately without saying which workspace
      // already holds the number.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
        throw new AppError(
          'PHONE_NUMBER_ALREADY_CONNECTED',
          'That phone number is already connected.',
          409,
        );
      }
      throw err;
    }
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

    // Carrier first, and only continue if it succeeded. Dropping the row after a
    // failed release orphans a number that keeps billing monthly with nothing
    // left in our database to find it by.
    if (number.type !== 'byo' && number.twilioSid) {
      await this.releaseFromTwilio(number.twilioSid);
    }
    const deleted = await this.prisma.twilioPhoneNumber.deleteMany({
      where: { id: numberId, workspaceId },
    });
    // Zero rows means a concurrent release won; the audit entry below belongs to
    // the caller that actually removed the row, not to both of them.
    if (deleted.count === 0) return;

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
