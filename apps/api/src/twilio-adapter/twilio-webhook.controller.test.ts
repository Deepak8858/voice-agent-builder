import { describe, expect, it, vi } from 'vitest';
import { TwilioWebhookController } from './twilio-webhook.controller';

function makePrisma(overrides?: { existingCall?: unknown; existingUsage?: unknown }) {
  return {
    twilioPhoneNumber: {
      findUnique: vi.fn(async () => ({
        id: 'number-1',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        phoneNumber: '+15551234567',
        workspace: { organizationId: 'organization-1' },
        agent: {
          id: 'agent-1',
          name: 'Reception agent',
          activeVersionId: 'version-1',
        },
      })),
    },
    call: {
      findFirst: vi.fn(async () => overrides?.existingCall ?? null),
      create: vi.fn(async () => ({ id: 'call-1' })),
      update: vi.fn(async () => ({ id: 'call-1' })),
    },
    callUsage: {
      findUnique: vi.fn(async () => overrides?.existingUsage ?? null),
    },
  };
}

function makeAdmission(admitted: boolean) {
  return {
    admitCall: vi.fn(async () =>
      admitted
        ? {
            admitted: true as const,
            leaseToken: 'lease-1',
            leaseExpiresAt: new Date('2026-06-07T10:01:00.000Z').toISOString(),
            reservedSeconds: 60,
          }
        : {
            admitted: false as const,
            reason: 'credit_insufficient' as const,
            message: 'No credit.',
          },
    ),
  };
}

const INBOUND_PAYLOAD = {
  CallSid: 'CA123',
  From: '+15557654321',
  To: '+15551234567',
};

describe('TwilioWebhookController.handleInbound', () => {
  it('propagates the phone number workspace organization to an inbound call', async () => {
    const prisma = makePrisma();
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      makeAdmission(true) as never,
    );

    await controller.handleInbound(INBOUND_PAYLOAD);

    expect(prisma.call.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'organization-1',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        providerCallId: 'CA123',
      }),
    });
    expect(prisma.twilioPhoneNumber.findUnique).toHaveBeenCalledWith({
      where: { phoneNumber: '+15551234567' },
      include: {
        agent: true,
        workspace: { select: { organizationId: true } },
      },
    });
  });

  it('streams media only after billing admits the inbound call', async () => {
    const prisma = makePrisma();
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD);

    expect(admission.admitCall).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'organization-1',
        workspaceId: 'workspace-1',
        callId: 'call-1',
        direction: 'inbound',
        providerCallId: 'CA123',
      }),
    );
    expect(sessionManager.create).toHaveBeenCalled();
    await expect(response.text()).resolves.toContain('<Stream');
  });

  it('refuses the caller and never opens a stream when billing denies the call', async () => {
    const prisma = makePrisma();
    const admission = makeAdmission(false);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD);
    const body = await response.text();

    expect(sessionManager.create).not.toHaveBeenCalled();
    expect(body).not.toContain('<Stream');
    expect(body).toContain('<Hangup/>');
    expect(prisma.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ status: 'failed', outcome: 'billing_denied' }),
      }),
    );
  });

  it('does not admit twice when Twilio retries the same inbound webhook', async () => {
    const prisma = makePrisma({
      existingCall: { id: 'call-1' },
      existingUsage: { id: 'usage-1' },
    });
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD);

    expect(prisma.call.create).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
    // The retry is still bridged: the call was already paid for.
    await expect(response.text()).resolves.toContain('<Stream');
  });
});
