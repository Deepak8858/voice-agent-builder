import { describe, expect, it, vi } from 'vitest';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { UnauthorizedError } from '../common/errors';

/**
 * A verifier that accepts every delivery, for the tests that are about what
 * happens after authentication succeeds.
 */
function makeVerifier() {
  return { assertValidSignature: vi.fn(async () => undefined) };
}

/** A verifier that rejects, standing in for an unsigned or forged delivery. */
function makeRejectingVerifier(message: string) {
  return {
    assertValidSignature: vi.fn(async () => {
      throw new UnauthorizedError(message);
    }),
  };
}

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
      upsert: vi.fn(async () => overrides?.existingCall ?? ({
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'organization-1',
        agentId: 'agent-1',
      })),
      findUnique: vi.fn(async () => overrides?.existingCall ?? null),
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

const SIGNED_HEADERS = { 'x-twilio-signature': 'valid-signature' };

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
      makeVerifier() as never,
    );

    await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS);

    expect(prisma.call.upsert).toHaveBeenCalledWith({
      where: {
        provider_providerCallId: { provider: 'twilio', providerCallId: 'CA123' },
      },
      create: expect.objectContaining({
        organizationId: 'organization-1',
        workspaceId: 'workspace-1',
        agentId: 'agent-1',
        providerCallId: 'CA123',
      }),
      update: {},
    });
    expect(prisma.twilioPhoneNumber.findUnique).toHaveBeenCalledWith({
      where: { phoneNumber: '+15551234567' },
      include: {
        agent: true,
        workspace: { select: { organizationId: true } },
      },
    });
  });

  it('verifies the Twilio signature before touching the database', async () => {
    const prisma = makePrisma();
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const verifier = makeVerifier();
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
      verifier as never,
    );

    await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS, {
      originalUrl: '/api/v1/voice/webhook/inbound',
    } as never);

    expect(verifier.assertValidSignature).toHaveBeenCalledWith(
      {
        headers: SIGNED_HEADERS,
        originalUrl: '/api/v1/voice/webhook/inbound',
        body: INBOUND_PAYLOAD,
      },
      'voice.inbound',
    );
    expect(verifier.assertValidSignature.mock.invocationCallOrder[0]!).toBeLessThan(
      prisma.twilioPhoneNumber.findUnique.mock.invocationCallOrder[0]!,
    );
  });

  it('rejects an unsigned inbound webhook without spending billing resources', async () => {
    const prisma = makePrisma();
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
      makeRejectingVerifier('Missing Twilio webhook signature.') as never,
    );

    await expect(controller.handleInbound(INBOUND_PAYLOAD, {})).rejects.toThrow(
      'Missing Twilio webhook signature.',
    );

    expect(prisma.twilioPhoneNumber.findUnique).not.toHaveBeenCalled();
    expect(prisma.call.upsert).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
  });

  it('rejects a forged inbound signature without spending billing resources', async () => {
    const prisma = makePrisma();
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
      makeRejectingVerifier('Invalid Twilio webhook signature.') as never,
    );

    await expect(
      controller.handleInbound(INBOUND_PAYLOAD, { 'x-twilio-signature': 'forged' }),
    ).rejects.toThrow('Invalid Twilio webhook signature.');

    expect(prisma.twilioPhoneNumber.findUnique).not.toHaveBeenCalled();
    expect(prisma.call.upsert).not.toHaveBeenCalled();
    expect(admission.admitCall).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
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
      makeVerifier() as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS);

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
      makeVerifier() as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS);
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

  it('retries admission when an earlier attempt was compensated and finalized', async () => {
    const prisma = makePrisma({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'organization-1',
        agentId: 'agent-1',
      },
      existingUsage: { finalizationState: 'finalized' },
    });
    const admission = makeAdmission(true);
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      { create: vi.fn(() => ({ id: 'session-1' })) } as never,
      prisma as never,
      admission as never,
      makeVerifier() as never,
    );

    await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS);

    expect(admission.admitCall).toHaveBeenCalledOnce();
  });

  it('does not admit twice when Twilio retries the same inbound webhook', async () => {
    const prisma = makePrisma({
      existingCall: {
        id: 'call-1',
        workspaceId: 'workspace-1',
        organizationId: 'organization-1',
        agentId: 'agent-1',
      },
      existingUsage: { finalizationState: 'pending' },
    });
    const admission = makeAdmission(true);
    const sessionManager = { create: vi.fn(() => ({ id: 'session-1' })) };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
      admission as never,
      makeVerifier() as never,
    );

    const response = await controller.handleInbound(INBOUND_PAYLOAD, SIGNED_HEADERS);

    expect(prisma.call.upsert).toHaveBeenCalledOnce();
    expect(admission.admitCall).not.toHaveBeenCalled();
    // The retry is still bridged: the call was already paid for.
    await expect(response.text()).resolves.toContain('<Stream');
  });
});
