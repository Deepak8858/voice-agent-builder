import { describe, expect, it, vi } from 'vitest';
import { TwilioWebhookController } from './twilio-webhook.controller';

describe('TwilioWebhookController', () => {
  it('propagates the phone number workspace organization to an inbound call', async () => {
    const prisma = {
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
        create: vi.fn(async () => ({ id: 'call-1' })),
      },
    };
    const sessionManager = {
      create: vi.fn(() => ({ id: 'session-1' })),
    };
    const controller = new TwilioWebhookController(
      {} as never,
      {} as never,
      sessionManager as never,
      prisma as never,
    );

    await controller.handleInbound({
      CallSid: 'CA123',
      From: '+15557654321',
      To: '+15551234567',
    });

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
});
