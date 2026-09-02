import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
  waitForParticipant as waitForRoomParticipant,
  waitForParticipantAttribute,
  type JobProcess,
  type VAD,
  type llm,
  type JobContext,
} from '@livekit/agents';
import { ParticipantKind } from '@livekit/rtc-node';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import {
  buildVoiceForgeInstructions,
  firstReplyInstruction,
  parseAgentSpec,
  parseDispatchMetadata,
  resolveRealtimeVoice,
  type DispatchMetadata,
} from './agent-runtime.js';
import {
  buildStandardSession,
  missingStandardPipelineConfig,
  type StandardPipelineEnv,
} from './standard-pipeline.js';
import {
  createKnowledgeSearchClient,
  createKnowledgeTool,
  retrievalChunkLimit,
} from './knowledge-retrieval.js';
import { createGoogleTools, createToolInvokeClient } from './google-tools.js';
import { createHandoffClient, createTransferTool } from './handoff.js';
import { createCallerDetailsClient, createCallerDetailsTool } from './caller-details.js';
import { CallMeter, createRuntimeUsageClient, runWithMeteredCall } from './runtime-usage.js';
import { resolveCallAttribution } from './call-attribution.js';
import {
  InboundCallRefusedError,
  createInboundAdmitClient,
  type InboundAdmitter,
} from './inbound-admit.js';

const prisma = new PrismaClient();

/**
 * Builds the metering lifecycle for a dispatched job.
 *
 * Metering requires a call, an organization, and internal API credentials.
 * Inbound dispatches resolve their call from the SIP participant before this is
 * invoked; a missing identity therefore fails the job instead of running an
 * admitted call without runtime enforcement.
 */
function createCallMeter(ctx: JobContext, metadata: DispatchMetadata): CallMeter | null {
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!metadata.callId || !metadata.organizationId) {
    throw new Error('[metering] callId and organizationId are required before a call can start.');
  }
  if (!apiBaseUrl || !internalApiKey) {
    throw new Error(
      '[metering] INTERNAL_API_BASE_URL/INTERNAL_API_KEY are required for attributed calls.',
    );
  }

  return new CallMeter({
    callId: metadata.callId,
    organizationId: metadata.organizationId,
    emit: createRuntimeUsageClient({ apiBaseUrl, internalApiKey }),
    ...(metadata.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: metadata.maxDurationSeconds }
      : {}),
    // Hanging up is the only enforcement the runtime has: a refused minute must
    // end the call rather than merely stop being recorded.
    terminate: async (reason) => {
      console.warn(`[metering] terminating call ${metadata.callId} after billing decision: ${reason}`);
      await ctx.room.disconnect().catch(() => undefined);
      ctx.shutdown(`billing:${reason}`);
    },
  });
}

/**
 * Builds the admitter for an inbound leg that no provider webhook admitted.
 *
 * Returns `null` when the internal credentials are absent: attribution then
 * fails closed on an unadmitted call instead of running one for free, and the
 * message names the missing configuration.
 */
function createInboundAdmitter(ctx: JobContext): InboundAdmitter | null {
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!apiBaseUrl || !internalApiKey) return null;
  return createInboundAdmitClient({
    apiBaseUrl,
    internalApiKey,
    roomName: ctx.room.name ?? null,
  });
}

/**
 * How long a dial-out may ring before the job gives up.
 *
 * Only a backstop: an unanswered call normally ends sooner, when the carrier
 * stops trying and the SIP participant leaves the room, which fails the wait
 * immediately.
 */
const RING_TIMEOUT_MS = 120_000;

/**
 * Resolves once the callee is actually on the call, or `false` if nobody is.
 *
 * Ring time is not billable. The API dials without blocking on answer
 * (`waitUntilAnswered: false`), so LiveKit puts the SIP participant in the room
 * while it is still ringing — being connected to the room proves only that we
 * started dialing. Holding the metering commit until the leg goes active is what
 * keeps ring time off the invoice.
 *
 * ponytail: gated on LiveKit's `sip.callStatus` attribute, the same signal the
 * SDK's own answering-machine detection uses. Ceiling: if LiveKit ever stops
 * publishing it, outbound calls bill nothing and never start — gate on the SIP
 * participant's audio track publication instead if that happens.
 */
async function waitUntilAnswered(ctx: JobContext): Promise<boolean> {
  const signal = AbortSignal.timeout(RING_TIMEOUT_MS);
  try {
    const sip = await waitForRoomParticipant({
      room: ctx.room,
      kind: ParticipantKind.SIP,
      signal,
    });
    await waitForParticipantAttribute({
      room: ctx.room,
      identity: sip.identity,
      attribute: 'sip.callStatus',
      value: 'active',
      signal,
    });
    return true;
  } catch (err) {
    // Nobody picked up. Shutting the job down now runs the metering shutdown
    // callback, which returns the reserved minute and frees the concurrency slot
    // instead of holding both until the room's own empty timeout.
    console.warn(
      `[metering] outbound call was never answered, so nothing is billable: ${(err as Error).message}`,
    );
    ctx.shutdown('ring_no_answer');
    return false;
  }
}

class VoiceForgeAgent extends voice.Agent {
  constructor(instructions: string, tools: llm.ToolContextEntry[]) {
    super({ instructions, tools });
  }
}

async function loadAgentSpec(metadata: DispatchMetadata): Promise<ReturnType<typeof parseAgentSpec>> {
  const agent = await prisma.agent.findUnique({
    where: { id: metadata.agentId },
    select: {
      id: true,
      workspaceId: true,
      specJson: true,
      activeVersionId: true,
    },
  });

  if (!agent) {
    throw new Error(`Agent ${metadata.agentId} was not found for dispatched LiveKit job.`);
  }

  if (agent.specJson) {
    return parseAgentSpec(agent.specJson);
  }

  if (agent.activeVersionId) {
    const version = await prisma.agentVersion.findUnique({
      where: { id: agent.activeVersionId },
      select: { specJson: true },
    });
    if (version?.specJson) {
      return parseAgentSpec(version.specJson);
    }
  }

  throw new Error(`Agent ${metadata.agentId} has no active Agent Spec JSON.`);
}

/** Key under which {@link prewarm} caches the loaded VAD on the job process. */
const VAD_USERDATA_KEY = 'vad';

export default defineAgent({
  // Loading the Silero ONNX model takes long enough to be audible if done once
  // per call, so it is loaded once per worker process and shared by every job
  // that process handles. Only the standard pipeline needs it — Realtime does
  // its own turn detection server-side — but prewarm cannot know which pipeline
  // the next job will use.
  prewarm: async (proc: JobProcess) => {
    try {
      proc.userData[VAD_USERDATA_KEY] = await silero.VAD.load();
    } catch (err) {
      // A failed prewarm must not take the worker down: Realtime calls do not
      // need VAD, and standard calls fail individually with a clear error.
      console.error('[prewarm] failed to load Silero VAD; standard-pipeline calls will fail.', err);
    }
  },
  entry: async (ctx: JobContext) => {
    const dispatchMetadata = parseDispatchMetadata(ctx.job.metadata);
    await ctx.connect();
    const participant = dispatchMetadata.callId ? null : await ctx.waitForParticipant();
    let metadata: DispatchMetadata;
    try {
      metadata = await resolveCallAttribution(
        dispatchMetadata,
        participant,
        prisma.call,
        createInboundAdmitter(ctx) ?? undefined,
      );
    } catch (err) {
      // A refused call is not a runtime fault: the API has already hung up the
      // carrier leg and there is no call row to meter, so the job ends quietly
      // instead of retrying or reporting a failure against a call it never ran.
      if (err instanceof InboundCallRefusedError) {
        console.warn(err.message);
        ctx.shutdown('admission_denied');
        return;
      }
      throw err;
    }
    const meter = createCallMeter(ctx, metadata);
    try {
      await runCall(ctx, metadata, meter, ctx.proc.userData[VAD_USERDATA_KEY] as VAD | undefined);
    } catch (err) {
      // The call never became billable. Reporting the failure is what returns
      // the reserved minute and frees the concurrency slot immediately.
      await meter?.failed('runtime_error');
      throw err;
    }
  },
});

async function runCall(
  ctx: JobContext,
  metadata: DispatchMetadata,
  meter: CallMeter | null,
  vad: VAD | undefined,
): Promise<void> {
  const spec = await loadAgentSpec(metadata);
  const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';
  const tools: llm.ToolContextEntry[] = [];
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  // Attribution (entry) guarantees a call id before any session runs; the
  // internal knowledge and tool routes require it to bind the agent to the
  // admitted call's tenant, so a missing id fails here rather than as a 403
  // mid-conversation.
  const callId = metadata.callId;
  if (!callId) {
    throw new Error('[runtime] callId is required before knowledge or tools can be configured.');
  }
  if (retrievalChunkLimit(spec) > 0) {
    const search = apiBaseUrl && internalApiKey
      ? createKnowledgeSearchClient({ apiBaseUrl, internalApiKey })
      : async () => {
          throw new Error('Knowledge retrieval is not configured.');
        };
    const knowledgeTool = createKnowledgeTool({
      spec,
      agentId: metadata.agentId,
      callId,
      search,
    });
    if (knowledgeTool) tools.push(knowledgeTool);
  }

  // Google tools (Calendar, Gmail, Sheets) referenced by the Agent Spec are
  // callable during live calls through the internal tool-invocation endpoint.
  // Each wrapper contains its own failures, so a broken integration degrades
  // to a fallback message instead of crashing the call.
  if (spec.tools.length > 0) {
    if (apiBaseUrl && internalApiKey) {
      const invoke = createToolInvokeClient({
        apiBaseUrl,
        internalApiKey,
        agentId: metadata.agentId,
        callId,
      });
      tools.push(...createGoogleTools({ spec, invoke }));
    } else {
      // Silent tool loss is very hard to diagnose from a live call; make the
      // misconfiguration visible in the worker logs.
      console.warn(
        `[google-tools] agent ${metadata.agentId} references ${spec.tools.length} tool(s) ` +
          'but INTERNAL_API_BASE_URL / INTERNAL_API_KEY are not configured; tools disabled for this call.',
      );
    }
  }

  // Warm transfer to the agent's configured human. The tool dials through the
  // API, so it needs the same credentials as the other tools; without them the
  // model is not offered a transfer it could not perform.
  if (apiBaseUrl && internalApiKey) {
    const transferTool = createTransferTool({
      spec,
      metadata,
      callId,
      room: ctx.room,
      dial: createHandoffClient({ apiBaseUrl, internalApiKey }),
      // The job stays alive while the two people talk so the call keeps being
      // metered; it ends when either of them hangs up.
      onTransferEnded: () => ctx.shutdown('transferred'),
    });
    if (transferTool) tools.push(transferTool);
  }

  // The agent's automatic Google Sheet (created at publish). Only offered when
  // the sheet exists, so the model is never told to save into nothing.
  let callerDetailsTool: llm.ToolContextEntry | null = null;
  if (apiBaseUrl && internalApiKey) {
    const sheet = await prisma.agentGoogleResource.findFirst({
      where: { agentId: metadata.agentId, status: 'ready' },
      select: { columns: true },
    });
    const columns = Array.isArray(sheet?.columns)
      ? (sheet.columns as Array<{ key?: unknown }>).map((c) => String(c.key ?? '')).filter(Boolean)
      : [];
    callerDetailsTool = createCallerDetailsTool({
      spec,
      agentId: metadata.agentId,
      callId,
      sheetColumns: columns,
      save: createCallerDetailsClient({ apiBaseUrl, internalApiKey }),
    });
    if (callerDetailsTool) tools.push(callerDetailsTool);
  }

  // The pipeline is a billing decision made by the API when the call was
  // created (free plans and half of starter calls run in-house), so it is read
  // from dispatch metadata rather than re-derived here.
  const session = metadata.pipeline === 'standard'
    ? buildStandardPipelineSession(spec, vad)
    : new voice.AgentSession({
        llm: new openai.realtime.RealtimeModel({
          voice: resolveRealtimeVoice(spec, fallbackVoice),
        }),
      });

  const startSession = async (): Promise<void> => {
    await session.start({
      agent: new VoiceForgeAgent(
        buildVoiceForgeInstructions(spec, metadata, { callerDetailsTool: callerDetailsTool !== null }),
        tools,
      ),
      room: ctx.room,
    });
    await session.generateReply({
      instructions: firstReplyInstruction(spec),
    });
  };

  if (!meter) {
    await startSession();
    return;
  }

  // Billing authorization must precede AgentSession.start(): both Realtime and
  // standard sessions begin automatic turn handling as soon as they start. On a
  // dial-out the room exists before the callee answers, so authorization waits
  // for the answer — billing ring time as talk time is the failure being avoided.
  await runWithMeteredCall(
    meter,
    metadata.providerCallId ?? ctx.room.name ?? callId,
    (callback) => ctx.addShutdownCallback(callback),
    startSession,
    metadata.direction === 'outbound' ? () => waitUntilAnswered(ctx) : undefined,
  );
}

/**
 * Builds the in-house cascaded session, requiring the prewarmed VAD.
 *
 * Turn detection is not optional for a cascaded pipeline — without it the agent
 * cannot tell when the caller stopped talking — so a missing VAD fails the call
 * rather than starting one that can never take a turn.
 */
function buildStandardPipelineSession(
  spec: ReturnType<typeof parseAgentSpec>,
  vad: VAD | undefined,
): voice.AgentSession<llm.ToolContext> {
  if (!vad) {
    throw new Error(
      'The standard voice pipeline requires the prewarmed Silero VAD, which failed to load on this worker.',
    );
  }
  return buildStandardSession({ spec, vad });
}

// Fail at boot like the API does, instead of failing every free-tier call at runtime.
if (/^(1|true|yes|on)$/i.test(process.env.VOICE_STANDARD_PIPELINE_ENABLED ?? '')) {
  const missingConfig = missingStandardPipelineConfig(process.env as StandardPipelineEnv);
  if (missingConfig.length > 0) {
    console.error(
      `VOICE_STANDARD_PIPELINE_ENABLED is set but the worker is missing ${missingConfig.join(', ')}.`,
    );
    process.exit(1);
  }
}

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
