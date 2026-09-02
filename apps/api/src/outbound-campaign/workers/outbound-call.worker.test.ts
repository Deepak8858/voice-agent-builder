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
  recordDispatchFailure: vi.fn(),
  getCampaign: vi.fn(),
  readSchedule: vi.fn(),
  dispatchContact: vi.fn(),
  advanceCursor: vi.fn(),
  markCompleted: vi.fn(),
};
const prisma = {
  telephonyPhoneNumber: {
    findFirst: vi.fn(),
  },
  outboundCampaign: {
    updateMany: vi.fn(),
  },
  call: {
    count: vi.fn(),
  },
};
const telephony = {
  startOutboundCall: vi.fn(),
};
const audit = {
  log: vi.fn(),
};

describe('OutboundCallWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.startOutboundCall.mockResolvedValue({
      id: 'call-1',
      status: 'queued',
      provider: 'openai-realtime',
    });
    telephony.startOutboundCall.mockResolvedValue({
      call_id: 'call-1',
      provider_call_id: 'participant-1',
      room_name: 'room-1',
    });
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue(null);
    prisma.outboundCampaign.updateMany.mockResolvedValue({ count: 1 });
    prisma.call.count.mockResolvedValue(0);
    campaigns.getCampaign.mockResolvedValue({
      id: 'camp-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      status: 'running',
      contacts: [{ phone: '+15551111111' }, { phone: '+15552222222' }],
      schedule: { max_calls_per_hour: 10, max_concurrent: 3 },
    });
    campaigns.readSchedule.mockReturnValue({ maxCallsPerHour: 10, maxConcurrent: 3 });
    campaigns.dispatchContact.mockResolvedValue(true);
  });

  // Every constructor dependency, in order - including `audit`, which this
  // factory used to omit. Nest always injects it in production, so a short
  // argument list left `this.audit` undefined in tests only, silently swallowing
  // the pause audit row behind the catch in pauseCampaign.
  function makeWorker() {
    return new (OutboundCallWorker as any)(
      queue as never,
      calls as never,
      campaigns as never,
      prisma as never,
      telephony as never,
      audit as never,
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
    await makeWorker().processor({
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
        purpose: 'requested_follow_up',
      },
    });
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
  });

  it('passes the campaign calling window through to the per-call compliance check', async () => {
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({ id: 'phone-number-1', provider: 'sip' });

    await makeWorker().processor({
      data: {
        campaignId: 'camp-1',
        agentId: 'agent-1',
        workspaceId: 'ws-1',
        actorUserId: 'user-1',
        to: '+15551111111',
        callWindow: { timezone: 'Asia/Kolkata', start_hour: 9, end_hour: 20 },
      },
    } as never);

    expect(telephony.startOutboundCall).toHaveBeenCalledWith(
      'ws-1',
      'user-1',
      expect.objectContaining({
        compliance: { call_window: { timezone: 'Asia/Kolkata', start_hour: 9, end_hour: 20 } },
      }),
    );
  });

  it('uses an assigned outbound BYO telephony number for campaign calls when available', async () => {
    prisma.telephonyPhoneNumber.findFirst.mockResolvedValue({
      id: 'phone-number-1',
      provider: 'vobiz',
    });
    await makeWorker().processor({
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
        purpose: 'requested_follow_up',
      },
    });
    expect(calls.startOutboundCall).not.toHaveBeenCalled();
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
  });

  it.each(['organization_concurrency_reached', 'billing_temporarily_unavailable'])(
    'rethrows a %s denial for retry without counting a failed dial',
    async (reason) => {
      calls.startOutboundCall.mockRejectedValue(
        new AppError('PLAN_LIMIT_EXCEEDED', 'denied', 403, { reason }),
      );

      await expect(makeWorker().processor(job)).rejects.toBeInstanceOf(AppError);

      expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
      expect(prisma.outboundCampaign.updateMany).not.toHaveBeenCalled();
    },
  );

  // Deliberate reversal: this test used to assert incrementStat('camp-1', 'failed')
  // on the pause branch. That was the bug. The contact is never dialled here and
  // the cursor is left at its index, so the resume re-dials it; counting it failed
  // now inflates the stat by one per pause/resume cycle.
  it('pauses the campaign without counting the undialled contact as failed', async () => {
    calls.startOutboundCall.mockRejectedValue(
      new AppError('PLAN_LIMIT_EXCEEDED', 'no credit', 403, { reason: 'credit_insufficient' }),
    );

    await expect(makeWorker().processor(job)).resolves.toBeUndefined();

    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
    expect(prisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'camp-1', status: 'running', workspaceId: 'ws-1' },
      data: { status: 'paused' },
    });
    expect(audit.log).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      action: 'billing.campaign_paused',
      resourceType: 'outbound_campaign',
      resourceId: 'camp-1',
      metadata: { reason: 'credit_insufficient', pausedBy: 'outbound_call_worker' },
    });
  });

  // F-028: pausing used to fall through to the chaining block below, which
  // enqueued contact index+1 and advanced the cursor past a contact that was
  // never dialled. `start()` resumes from `dispatchedCount`, so that contact was
  // silently lost for good.
  it('stops the chain on a blocking denial, leaving the cursor at the undialled contact', async () => {
    campaigns.getCampaign.mockResolvedValue({
      id: 'camp-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      status: 'running',
      dispatchedCount: 4,
      contacts: [{ phone: '+15551111111' }, { phone: '+15552222222' }],
      schedule: { max_calls_per_hour: 10, max_concurrent: 3 },
    });
    calls.startOutboundCall.mockRejectedValue(
      new AppError('PLAN_LIMIT_EXCEEDED', 'no credit', 403, { reason: 'subscription_inactive' }),
    );

    await expect(
      makeWorker().processor({
        data: { ...(job as any).data, contactIndex: 4, dispatchToken: 7 },
      } as never),
    ).resolves.toBeUndefined();

    expect(prisma.outboundCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'camp-1', status: 'running', workspaceId: 'ws-1' },
      data: { status: 'paused' },
    });
    // Nothing further enqueued, and the cursor stays at 4 so a resume re-dials
    // the contact billing refused rather than starting at 5 - which is exactly
    // why contact 4 must not be counted as a failed dial on the way out.
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
    expect(campaigns.dispatchContact).not.toHaveBeenCalled();
    expect(campaigns.advanceCursor).not.toHaveBeenCalled();
    expect(campaigns.markCompleted).not.toHaveBeenCalled();
  });

  // The "pause before the stats write" ordering test that lived here is gone with
  // the stats write itself: the pause branch no longer touches incrementStat, so
  // there is no non-critical write left that could strand a running campaign.

  // F-021: a pause has to stop the dial, not just relabel the campaign.
  it('does not dial for a campaign that is no longer running', async () => {
    campaigns.getCampaign.mockResolvedValue({
      id: 'camp-1',
      workspaceId: 'ws-1',
      status: 'paused',
      contacts: [{ phone: '+15551111111' }],
      schedule: { max_calls_per_hour: 10, max_concurrent: 3 },
    });

    await makeWorker().processor({ data: { ...(job as any).data, contactIndex: 0 } } as never);

    expect(calls.startOutboundCall).not.toHaveBeenCalled();
    expect(telephony.startOutboundCall).not.toHaveBeenCalled();
    expect(campaigns.dispatchContact).not.toHaveBeenCalled();
    expect(campaigns.advanceCursor).not.toHaveBeenCalled();
  });

  // A delayed job that survived a pause must not re-dial a contact the resumed
  // chain has already passed, and must not fork a second chain.
  it('drops a chain link the dispatch cursor has already moved past', async () => {
    campaigns.getCampaign.mockResolvedValue({
      id: 'camp-1',
      workspaceId: 'ws-1',
      status: 'running',
      dispatchedCount: 3,
      contacts: [{ phone: '+15551111111' }],
      schedule: { max_calls_per_hour: 10, max_concurrent: 3 },
    });

    await makeWorker().processor({ data: { ...(job as any).data, contactIndex: 1 } } as never);

    expect(calls.startOutboundCall).not.toHaveBeenCalled();
    expect(campaigns.dispatchContact).not.toHaveBeenCalled();
  });

  // F-027: max_calls_per_hour is the gap between chained jobs.
  it('chains the next contact spaced by max_calls_per_hour and advances the cursor', async () => {
    campaigns.readSchedule.mockReturnValue({ maxCallsPerHour: 60, maxConcurrent: 3 });

    await makeWorker().processor({
      data: { ...(job as any).data, contactIndex: 0, dispatchToken: 1234 },
    } as never);

    expect(campaigns.dispatchContact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'camp-1' }),
      1,
      'user-1',
      60_000,
      1234,
    );
    expect(campaigns.advanceCursor).toHaveBeenCalledWith('camp-1', 'ws-1', 1);
    expect(calls.startOutboundCall).toHaveBeenCalled();
  });

  // F-027: max_concurrent was persisted and enforced nowhere.
  it('defers the contact instead of dialling when the campaign is at max_concurrent', async () => {
    campaigns.readSchedule.mockReturnValue({ maxCallsPerHour: 60, maxConcurrent: 2 });
    prisma.call.count.mockResolvedValue(2);

    await makeWorker().processor({
      data: { ...(job as any).data, contactIndex: 0, dispatchToken: 1234 },
    } as never);

    expect(calls.startOutboundCall).not.toHaveBeenCalled();
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
    // Same contact, re-queued under a fresh token so the delayed job is not
    // deduplicated against the one currently running.
    expect(campaigns.dispatchContact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'camp-1' }),
      0,
      'user-1',
      30_000,
      1235,
    );
    expect(campaigns.advanceCursor).not.toHaveBeenCalled();
    expect(prisma.call.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: 'ws-1', agentId: 'agent-1' }),
    });
  });

  // F-022: the worker used to throw here and rely on a BullMQ retry that was
  // never configured. A paced job holds the contact instead, so a denial that
  // outlasts the retry budget cannot end the chain.
  it('holds a contact on a retryable admission denial instead of failing the job', async () => {
    calls.startOutboundCall.mockRejectedValue(
      new AppError('PLAN_LIMIT_EXCEEDED', 'denied', 403, {
        reason: 'organization_concurrency_reached',
      }),
    );

    await expect(
      makeWorker().processor({
        data: { ...(job as any).data, contactIndex: 0, dispatchToken: 7 },
      } as never),
    ).resolves.toBeUndefined();

    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
    expect(campaigns.dispatchContact).toHaveBeenCalledWith(
      expect.anything(),
      0,
      'user-1',
      30_000,
      8,
    );
    // The chain must not advance past a contact that was never called.
    expect(campaigns.advanceCursor).not.toHaveBeenCalled();
  });

  it('holds a contact when the agent call window has closed, and burns one that is on a DNC list', async () => {
    const blocked = (code: string) =>
      new AppError('COMPLIANCE_BLOCKED', 'blocked', 422, {
        reasons: [{ code, message: code, severity: 'blocking' }],
      });

    calls.startOutboundCall.mockRejectedValue(blocked('outside_call_window'));
    await makeWorker().processor({
      data: { ...(job as any).data, contactIndex: 0, dispatchToken: 7 },
    } as never);

    expect(campaigns.dispatchContact).toHaveBeenCalledWith(
      expect.anything(),
      0,
      'user-1',
      15 * 60_000,
      8,
    );
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prisma.call.count.mockResolvedValue(0);
    campaigns.getCampaign.mockResolvedValue({ id: 'camp-1', status: 'running', schedule: {} });
    campaigns.readSchedule.mockReturnValue({ maxCallsPerHour: 10, maxConcurrent: 3 });
    campaigns.dispatchContact.mockResolvedValue(true);
    calls.startOutboundCall.mockRejectedValue(blocked('dnc_match'));

    await makeWorker().processor({
      data: { ...(job as any).data, contactIndex: 0, dispatchToken: 7 },
    } as never);

    // A permanent block is a failed dial, and the chain moves on. The compliance
    // engine refuses before any call row exists, so this is the one failure the
    // campaign has to count for itself.
    expect(campaigns.recordDispatchFailure).toHaveBeenCalledWith('camp-1', 'contact:0');
    expect(campaigns.advanceCursor).toHaveBeenCalledWith('camp-1', 'ws-1', 1);
  });

  it('marks the campaign completed once the last contact has been dispatched', async () => {
    campaigns.dispatchContact.mockResolvedValue(false);

    await makeWorker().processor({ data: { ...(job as any).data, contactIndex: 1 } } as never);

    expect(calls.startOutboundCall).toHaveBeenCalled();
    expect(campaigns.markCompleted).toHaveBeenCalledWith('camp-1', 'ws-1');
  });

  it('counts a non-billing dispatch error as a failed dial and keeps the campaign running', async () => {
    calls.startOutboundCall.mockRejectedValue(new Error('provider timeout'));

    await expect(makeWorker().processor(job)).resolves.toBeUndefined();

    // No contact index on this job (a pre-chaining job still in the queue), so
    // the attempt is keyed by the number it was dialling.
    expect(campaigns.recordDispatchFailure).toHaveBeenCalledWith('camp-1', 'to:+15551111111');
    expect(prisma.outboundCampaign.updateMany).not.toHaveBeenCalled();
  });

  // The other half of that: a dial that failed after the call row was written is
  // already counted from the row itself, so counting it here as well would show
  // one failed contact as two.
  it('does not count a dispatch error that already left a failed call row', async () => {
    calls.startOutboundCall.mockRejectedValue(new Error('provider dispatch failed'));
    prisma.call.count.mockResolvedValue(1);

    await expect(makeWorker().processor(job)).resolves.toBeUndefined();

    expect(prisma.call.count).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        AND: [
          { metadata: { path: ['campaign_id'], equals: 'camp-1' } },
          { toNumber: '+15551111111' },
        ],
      },
    });
    expect(campaigns.recordDispatchFailure).not.toHaveBeenCalled();
  });

  /**
   * A contact list may hold the same number twice. Matching the "did this become
   * a call" lookup on the number would let the first contact's call row hide the
   * second contact's failure, so the lookup is keyed by the contact's position.
   */
  it('counts a failure for a repeated number that a sibling contact already dialled', async () => {
    calls.startOutboundCall.mockRejectedValue(new Error('provider timeout'));
    // A row exists for this number (contact 0), but none for contact 1.
    prisma.call.count.mockResolvedValue(0);

    await makeWorker().processor({
      data: { ...(job as any).data, contactIndex: 1, dispatchToken: 7 },
    } as never);

    expect(prisma.call.count).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws-1',
        AND: [
          { metadata: { path: ['campaign_id'], equals: 'camp-1' } },
          { metadata: { path: ['contact_index'], equals: 1 } },
        ],
      },
    });
    expect(campaigns.recordDispatchFailure).toHaveBeenCalledWith('camp-1', 'contact:1');
  });

  /**
   * `custom_data` comes from the customer's CSV. A column called `campaign_id`
   * would otherwise reassign the call to another campaign: it would vanish from
   * this campaign's statistics, and the dispatch-failure lookup would never find
   * it either.
   */
  it('keeps campaign_id and purpose out of reach of a contact custom field', async () => {
    await makeWorker().processor({
      data: {
        ...(job as any).data,
        contactIndex: 3,
        purpose: 'appointment_reminder',
        customData: { campaign_id: 'someone-elses', purpose: 'marketing', source: 'csv' },
      },
    } as never);

    expect(calls.startOutboundCall).toHaveBeenCalledWith(
      'ws-1',
      'agent-1',
      'user-1',
      expect.objectContaining({
        metadata: {
          source: 'csv',
          campaign_id: 'camp-1',
          contact_index: 3,
          purpose: 'appointment_reminder',
        },
      }),
    );
  });
});
