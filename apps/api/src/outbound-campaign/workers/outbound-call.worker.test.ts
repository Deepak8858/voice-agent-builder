import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../common/errors';
import { OutboundCallWorker } from './outbound-call.worker';

vi.mock('../../workers/base.worker', () => ({
  BaseWorker: class {
    protected readonly logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    constructor() {}
  },
}));

const queue = {};
const calls = {
  startOutboundCall: vi.fn(),
};
const campaigns = {
  incrementStat: vi.fn(),
};
const prisma = {
  telephonyPhoneNumber: {
    findFirst: vi.fn(),
  },
  outboundCampaign: {
    updateMany: vi.fn(),
  },
};
const telephony = {
  startOutboundCall: vi.fn(),
};

describe('OutboundCallWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.startOutboundCall.mockResolvedValue({
      id: 'call-1',
      status: 'queued',
      provider: 'vapi',
    });
    telephony.startOutboundCall.mockResolvedValue({
      call_id: 'call-1',
      provider_call_id: 'participant-1',
      room_name: 'room-1',
    });
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null);
    prisma.outboundCampaign.updateMany.mockResolvedValue({ count: 1 });
  });

  function makeWorker() {
    return new (OutboundCallWorker as any)(
      queue as never,
      calls as never,
      campaigns as never,
      prisma as never,
      telephony as never,
    );
  }

  const job = {
    data: {
      campaignId: 'camp-1',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      actorUserId: 'user-1',
      to: '+15551111111',
    },
  } as never;

  it('starts campaign calls through the compliance-checked CallsService path', async () => {
    const worker = new (OutboundCallWorker as any)(
      queue as never,
      calls as never,
      campaigns as never,
      prisma as never,
      telephony as never,
    );

    await worker.processor({
      data: {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        to: '+15551111111',
        contactName: 'Alice',
        customData: { source: 'csv' },
      },
    } as never);

    expect(calls.startOutboundCall).toHaveBeenCalledWith('ws-1', 'agent-1', 'user-1', {
      to_number: '+15551111111',
      contact_name: 'Alice',
      metadata: {
        campaign_id: 'camp-1',
        source: 'csv',
        purpose: 'outbound_campaign',
      },
    });
    expect(campaigns.incrementStat).toHaveBeenCalledWith('camp-1', 'in_progress');
  });

  it('uses an assigned outbound BYO telephony number for campaign calls when available', async () => {
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'phone-number-1',
      provider: 'vobiz',
    });
    const worker = new (OutboundCallWorker as any)(
      queue as never,
      calls as never,
      campaigns as never,
      prisma as never,
      telephony as never,
    );

    await worker.processor({
      data: {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        to: '+15551111111',
        contactName: 'Alice',
        customData: { source: 'csv' },
      },
    } as never);

    expect(telephony.startOutboundCall).toHaveBeenCalledWith('ws-1', 'user-1', {
      phone_number_id: 'phone-number-1',
      to_number: '+15551111111',
      contact_name: 'Alice',
      metadata: {
        campaign_id: 'camp-1',
        source: 'csv',
        purpose: 'outbound_campaign',
      },
    });
    expect(calls.startOutboundCall).not.toHaveBeenCalled();
    expect(campaigns.incrementStat).toHaveBeenCalledWith('camp-1', 'in_progress');
  });

  it.each(['organization_concurrency_reached', 'billing_temporarily_unavailable'])(
    'rethrows a %s denial for retry without counting a failed dial',
    async (reason) => {
      calls.startOutboundCall.mockRejectedValue(
        new AppError('PLAN_LIMIT_EXCEEDED', 'denied', 403, { reason }),
      );

      await expect(makeWorker().processor(job)).rejects.toBeInstanceOf(AppError);

      expect(campaigns.incrementStat).not.toHaveBeenCalled();
      expect(prisma.outboundCampaign.updateMany).not.toHaveBeenCalled();
    },
  );

  it('pauses the campaign when the organization is out of credit', async () => {
    calls.startOutboundCall.mockRejectedValue(
      new AppError('PLAN_LIMIT_EXCEEDED', 'no credit', 403, { reason: 'credit_insufficient' }),
    );

    await expect(makeWorker().processor(job)).resolves.toBeUndefined();

    expect(campaigns.incrementStat).toHaveBeenCalledWith('camp-1', 'failed');
    expect(prisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'camp-1', status: 'running' },
      data: { status: 'paused' },
    });
  });

  it('pauses before recording failure statistics so a stats error cannot leave dispatch running', async () => {
    calls.startOutboundCall.mockRejectedValue(
      new AppError('PLAN_LIMIT_EXCEEDED', 'no credit', 403, { reason: 'credit_insufficient' }),
    );
    campaigns.incrementStat.mockRejectedValueOnce(new Error('stats unavailable'));

    await expect(makeWorker().processor(job)).rejects.toThrow('stats unavailable');

    expect(prisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'camp-1', status: 'running' },
      data: { status: 'paused' },
    });
    expect(prisma.outboundCampaign.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      campaigns.incrementStat.mock.invocationCallOrder[0]!,
    );
  });

  it('counts a non-billing dispatch error as a failed dial and keeps the campaign running', async () => {
    calls.startOutboundCall.mockRejectedValue(new Error('provider timeout'));

    await expect(makeWorker().processor(job)).resolves.toBeUndefined();

    expect(campaigns.incrementStat).toHaveBeenCalledWith('camp-1', 'failed');
    expect(prisma.outboundCampaign.updateMany).not.toHaveBeenCalled();
  });
});
