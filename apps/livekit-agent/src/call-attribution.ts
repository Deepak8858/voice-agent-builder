import type { DispatchMetadata } from './agent-runtime.js';

interface SipParticipant {
  attributes: Record<string, string>;
}

interface CallLookup {
  findFirst(args: {
    where: {
      provider: string;
      providerCallId: string;
      organizationId: string;
      workspaceId: string;
      phoneNumberId: string;
      agentId: string;
      direction: 'inbound';
    };
    select: { id: true; organizationId: true };
  }): Promise<{ id: string; organizationId: string } | null>;
}

/**
 * Resolves the exact call admitted by the signed Twilio voice webhook.
 *
 * A static inbound dispatch rule cannot contain a per-call id. LiveKit exposes
 * Twilio's original CallSid on the SIP participant, so the runtime joins that
 * immutable provider identity to all tenant dimensions carried by the rule.
 * Missing or mismatched identity fails closed rather than guessing by room,
 * number, or recency.
 */
export async function resolveCallAttribution(
  metadata: DispatchMetadata,
  participant: SipParticipant | null,
  calls: CallLookup,
): Promise<DispatchMetadata> {
  if (metadata.callId) return metadata;
  if (metadata.direction !== 'inbound') {
    throw new Error('[metering] an attributed non-inbound dispatch must include callId.');
  }
  if (
    !metadata.organizationId ||
    !metadata.workspaceId ||
    !metadata.phoneNumberId ||
    !metadata.provider
  ) {
    throw new Error('[metering] inbound dispatch metadata is missing tenant attribution.');
  }

  const providerCallId = participant?.attributes['sip.twilio.callSid']?.trim();
  if (!providerCallId) {
    throw new Error('[metering] inbound SIP participant is missing sip.twilio.callSid.');
  }

  const call = await calls.findFirst({
    where: {
      provider: metadata.provider,
      providerCallId,
      organizationId: metadata.organizationId,
      workspaceId: metadata.workspaceId,
      phoneNumberId: metadata.phoneNumberId,
      agentId: metadata.agentId,
      direction: 'inbound',
    },
    select: { id: true, organizationId: true },
  });
  if (!call || call.organizationId !== metadata.organizationId) {
    throw new Error('[metering] no admitted inbound call matches the SIP participant.');
  }

  return { ...metadata, callId: call.id, providerCallId };
}
