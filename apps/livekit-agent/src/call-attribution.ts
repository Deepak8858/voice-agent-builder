import type { DispatchMetadata } from './agent-runtime.js';
import {
  InboundCallRefusedError,
  type InboundAdmitInput,
  type InboundAdmitter,
} from './inbound-admit.js';

interface SipParticipant {
  identity?: string;
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
 * Resolves the call this inbound dispatch belongs to, admitting it if nobody
 * has yet.
 *
 * A static inbound dispatch rule cannot contain a per-call id, so the runtime
 * joins the SIP participant's immutable provider identity to all tenant
 * dimensions carried by the rule. Two deliveries exist: a Twilio Programmable
 * Voice number arrives through the signed voice webhook, which admitted the
 * call already and exposes `sip.twilio.callSid`; a number on any SIP trunk
 * (BYO, Vobiz, or a Twilio Elastic SIP trunk) arrives with no webhook at all
 * and only LiveKit's own `sip.callID`. The second case is admitted here, via
 * the API, so both deliveries end up with the same admitted call row.
 *
 * Missing identity, a mismatched tenant, or no admitter for a call nobody
 * admitted all fail closed rather than guessing by room, number, or recency.
 */
export async function resolveCallAttribution(
  metadata: DispatchMetadata,
  participant: SipParticipant | null,
  calls: CallLookup,
  admit?: InboundAdmitter,
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

  const attributes = participant?.attributes ?? {};
  const providerCallId =
    attributes['sip.twilio.callSid']?.trim() || attributes['sip.callID']?.trim();
  if (!providerCallId) {
    throw new Error(
      '[metering] inbound SIP participant carries neither sip.twilio.callSid nor sip.callID.',
    );
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
  if (call) {
    if (call.organizationId !== metadata.organizationId) {
      throw new Error('[metering] the matched inbound call belongs to another organization.');
    }
    return { ...metadata, callId: call.id, providerCallId };
  }

  // Nobody admitted this call, so it was delivered over SIP without a provider
  // webhook. Asking the API is what reserves the minute and the concurrency
  // slot; without an admitter there is no paid call to run.
  if (!admit) {
    throw new Error('[metering] no admitted inbound call matches the SIP participant.');
  }
  const admission = await admit({
    organizationId: metadata.organizationId,
    workspaceId: metadata.workspaceId,
    phoneNumberId: metadata.phoneNumberId,
    agentId: metadata.agentId,
    // The dispatch rule's metadata is JSON, so its provider is a plain string
    // here; the API re-validates it against the same enum this cast names.
    provider: metadata.provider as InboundAdmitInput['provider'],
    providerCallId,
    fromNumber: attributes['sip.phoneNumber']?.trim() || null,
    toNumber: attributes['sip.trunkPhoneNumber']?.trim() || null,
    participantIdentity: participant?.identity ?? null,
  });
  if (!admission.admitted || !admission.callId) {
    throw new InboundCallRefusedError(admission.reason ?? 'admission_denied');
  }

  return { ...metadata, callId: admission.callId, providerCallId };
}
