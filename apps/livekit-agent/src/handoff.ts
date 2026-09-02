import { llm, voice } from '@livekit/agents';
import { ParticipantKind, RoomEvent, type Participant, type Room } from '@livekit/rtc-node';
import {
  HandoffDialResponseSchema,
  type AgentSpec,
  type HandoffDialRequest,
  type HandoffDialResponse,
} from '@voiceforge/shared';
import { z } from 'zod';
import { canTransferToHuman, type DispatchMetadata } from './agent-runtime.js';

/**
 * Announced warm transfer to the agent's configured human.
 *
 * The caller holds with music while the API dials the human into the same
 * room. Once they answer, the agent introduces the caller and the reason for
 * the call, then goes quiet: its microphone and speaker are switched off, and
 * the job stays up so the call keeps being metered until one of the two people
 * hangs up. If nobody answers the agent gets the caller back and is told to
 * offer a message.
 */

const HandoffEnvelopeSchema = z.object({
  success: z.literal(true),
  data: HandoffDialResponseSchema,
});

export type HandoffDialer = (input: HandoffDialRequest) => Promise<HandoffDialResponse>;

/**
 * Must outlive the API's own ring budget (25 s) plus its RPC slack, or the
 * runtime abandons a dial the human is about to answer.
 */
const DIAL_TIMEOUT_MS = 45_000;

export function createHandoffClient(config: {
  apiBaseUrl: string;
  internalApiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): HandoffDialer {
  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '');
  const fetchImpl = config.fetchImpl ?? fetch;
  return async (input) => {
    const response = await fetchImpl(`${baseUrl}/api/v1/internal/runtime/handoff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key': config.internalApiKey,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(config.timeoutMs ?? DIAL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`[handoff] dial endpoint returned ${response.status}.`);
    }
    return HandoffEnvelopeSchema.parse(await response.json()).data;
  };
}

/** Starts hold music on its own track; the returned function stops it. */
export type HoldMusic = (room: Room, session: voice.AgentSession) => Promise<() => Promise<void>>;

const playHoldMusic: HoldMusic = async (room, session) => {
  const player = new voice.BackgroundAudioPlayer();
  await player.start({ room, agentSession: session });
  const handle = player.play(voice.BuiltinAudioClip.HOLD_MUSIC, true);
  return async () => {
    handle.stop();
    await player.close();
  };
};

export function createTransferTool(config: {
  spec: AgentSpec;
  metadata: DispatchMetadata;
  callId: string;
  room: Room;
  dial: HandoffDialer;
  /** Called once the transferred call ends (either person hangs up). */
  onTransferEnded: () => void;
  holdMusic?: HoldMusic;
}): llm.ToolContextEntry | null {
  if (!canTransferToHuman(config.spec, config.metadata)) return null;
  const holdMusic = config.holdMusic ?? playHoldMusic;

  return llm.tool({
    name: 'transfer_to_human',
    description:
      'Connect the caller to a human colleague. Call this only after telling the caller you will connect them and asking them to hold. The colleague hears your summary when they answer.',
    parameters: z.object({
      summary: z
        .string()
        .trim()
        .min(1)
        .max(600)
        .describe('One or two sentences for the colleague: who is calling and what they need.'),
    }),
    execute: async ({ summary }, { ctx }) => {
      const session = ctx.session;
      // The caller is on hold: the agent should neither hear nor answer them
      // until the dial has settled one way or the other.
      session.input.setAudioEnabled(false);
      // Music is comfort, not correctness; a failure to play it must not cost
      // the transfer.
      const stopHold = await holdMusic(config.room, session).catch((err: unknown) => {
        console.warn(`[handoff] hold music unavailable: ${(err as Error).message}`);
        return async () => undefined;
      });

      let result: HandoffDialResponse;
      try {
        result = await config.dial({
          callId: config.callId,
          agentId: config.metadata.agentId,
          summary,
        });
      } catch (err) {
        result = { connected: false, participantIdentity: null, reason: (err as Error).message };
      }
      await stopHold().catch(() => undefined);

      if (!result.connected) {
        console.warn(`[handoff] transfer failed for call ${config.callId}: ${result.reason}`);
        session.input.setAudioEnabled(true);
        return {
          transferred: false,
          instruction:
            'Nobody could be reached. Apologise briefly, offer to take a message or arrange a call back, and continue helping the caller.',
        };
      }

      // The warm part: a different speech handle from the one running this
      // tool, so awaiting its playout is safe. Interruptions are off so the
      // introduction is not cut short by either person saying hello.
      await session
        .generateReply({
          instructions: `A human colleague has just joined this call and can hear you. In one or two sentences greet them, tell them who is calling and what they need: ${summary}. Then say you are leaving them to talk. Do not ask a question.`,
          allowInterruptions: false,
        })
        .waitForPlayout();

      // Step out without leaving: the two people keep talking in the room while
      // this job stays up to meter the call. Either of them hanging up ends it.
      session.output.setAudioEnabled(false);
      const onLeft = (participant: Participant): void => {
        if (participant.kind !== ParticipantKind.SIP) return;
        config.room.off(RoomEvent.ParticipantDisconnected, onLeft);
        config.onTransferEnded();
      };
      config.room.on(RoomEvent.ParticipantDisconnected, onLeft);

      return { transferred: true, instruction: 'The transfer is complete. Say nothing further.' };
    },
  });
}
