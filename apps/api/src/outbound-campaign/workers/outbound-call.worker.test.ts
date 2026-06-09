import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundCallWorker } from './outbound-call.worker';

vi.mock('../../workers/base.worker', () => ({
  BaseWorker: class {
    protected readonly logger = {
      log: vi.fn(),
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
  });

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
});
