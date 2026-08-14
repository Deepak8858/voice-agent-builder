import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
  type llm,
  type JobContext,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
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
  createKnowledgeSearchClient,
  createKnowledgeTool,
  retrievalChunkLimit,
} from './knowledge-retrieval.js';
import { CallMeter, createRuntimeUsageClient } from './runtime-usage.js';

const prisma = new PrismaClient();

/**
 * Builds the metering lifecycle for a dispatched job.
 *
 * Metering requires a call, an organization, and internal API credentials. A
 * dispatch missing any of them cannot be attributed to a payer, so no usage is
 * reported for it — the API never sees an event it cannot scope, and nothing is
 * billed to a guessed tenant. Inbound dispatch rules fall in this category
 * today; see the inbound admission gap in the billing runbook.
 */
function createCallMeter(ctx: JobContext, metadata: DispatchMetadata): CallMeter | null {
  const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
  const internalApiKey = process.env.INTERNAL_API_KEY;
  if (!metadata.callId || !metadata.organizationId) {
    console.warn(
      `[metering] dispatch for agent ${metadata.agentId} has no callId/organizationId; usage will not be reported.`,
    );
    return null;
  }
  if (!apiBaseUrl || !internalApiKey) {
    console.error(
      '[metering] INTERNAL_API_BASE_URL/INTERNAL_API_KEY are not configured; call usage will not be reported.',
    );
    return null;
  }

  return new CallMeter({
    callId: metadata.callId,
    organizationId: metadata.organizationId,
    emit: createRuntimeUsageClient({ apiBaseUrl, internalApiKey }),
    // Hanging up is the only enforcement the runtime has: a refused minute must
    // end the call rather than merely stop being recorded.
    terminate: async (reason) => {
      console.warn(`[metering] terminating call ${metadata.callId} after billing decision: ${reason}`);
      await ctx.room.disconnect().catch(() => undefined);
      ctx.shutdown(`billing:${reason}`);
    },
  });
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

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const metadata = parseDispatchMetadata(ctx.job.metadata);
    const meter = createCallMeter(ctx, metadata);
    try {
      await runCall(ctx, metadata, meter);
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
): Promise<void> {
  const spec = await loadAgentSpec(metadata);
  const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';
  const tools: llm.ToolContextEntry[] = [];
  if (retrievalChunkLimit(spec) > 0) {
    const apiBaseUrl = process.env.INTERNAL_API_BASE_URL;
    const internalApiKey = process.env.INTERNAL_API_KEY;
    const search = apiBaseUrl && internalApiKey
      ? createKnowledgeSearchClient({ apiBaseUrl, internalApiKey })
      : async () => {
          throw new Error('Knowledge retrieval is not configured.');
        };
    const knowledgeTool = createKnowledgeTool({
      spec,
      agentId: metadata.agentId,
      search,
    });
    if (knowledgeTool) tools.push(knowledgeTool);
  }

  const session = new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({
      voice: resolveRealtimeVoice(spec, fallbackVoice),
    }),
  });

  await session.start({
    agent: new VoiceForgeAgent(buildVoiceForgeInstructions(spec, metadata), tools),
    room: ctx.room,
  });

  await ctx.connect();

  if (meter) {
    // Registered before the first reply so a crash mid-conversation still
    // settles the call instead of leaking its reservation and lease.
    ctx.addShutdownCallback(async () => {
      await meter.ended();
    });
    // The room name is what LiveKit dispatch reports as the provider call id
    // when no SIP participant id is available, so metering and the call record
    // agree on the same identifier.
    await meter.connected(ctx.room.name || (metadata.callId as string));
    meter.start();
  }

  await session.generateReply({
    instructions: firstReplyInstruction(spec),
  });
}

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
