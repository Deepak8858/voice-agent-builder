import { z } from 'zod';
import {
  InboundCallAdmitResponseSchema,
  type InboundCallAdmitRequest,
  type InboundCallAdmitResponse,
} from '@voiceforge/shared';

/**
 * Client for `POST /internal/runtime/inbound/admit`.
 *
 * An inbound call delivered straight to LiveKit over SIP has no provider
 * webhook that could have admitted it before the agent was dispatched, so the
 * agent asks the API itself — once, before it says a word. Refusal is enforced
 * API-side (it removes the SIP participant, which makes LiveKit send BYE to the
 * carrier), so this client only has to stop the job.
 */
const InboundAdmitResponseEnvelopeSchema = z.object({
  success: z.literal(true),
  data: InboundCallAdmitResponseSchema,
});

/**
 * Everything the request needs except the room, which this client owns (it is
 * created per job). Derived from the zod contract so the two cannot drift.
 */
export type InboundAdmitInput = Omit<InboundCallAdmitRequest, 'roomName'>;

export type InboundAdmitter = (input: InboundAdmitInput) => Promise<InboundCallAdmitResponse>;

/** The call was not paid for; the API has already hung up the carrier leg. */
export class InboundCallRefusedError extends Error {
  constructor(public readonly reason: string) {
    super(`[admission] inbound call refused: ${reason}`);
    this.name = 'InboundCallRefusedError';
  }
}

export interface InboundAdmitClientConfig {
  apiBaseUrl: string;
  internalApiKey: string;
  /** Room holding the SIP leg, so the API can hang it up when it refuses. */
  roomName: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function createInboundAdmitClient(config: InboundAdmitClientConfig): InboundAdmitter {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Not retried: the caller is on the line and admission is the gate in front of
  // a billable minute. A retry would spend ring time on a request the API may
  // already have processed, and the job failing is the safe outcome.
  return async (input) => {
    const response = await fetchImpl(`${baseUrl}/api/v1/internal/runtime/inbound/admit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': config.internalApiKey,
      },
      body: JSON.stringify({ ...input, roomName: config.roomName }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`[admission] admit endpoint returned ${response.status}.`);
    }
    return InboundAdmitResponseEnvelopeSchema.parse(await response.json()).data;
  };
}
