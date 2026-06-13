import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
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

const prisma = new PrismaClient();

class VoiceForgeAgent extends voice.Agent {
  constructor(instructions: string) {
    super({ instructions });
  }
}

async function loadAgentSpec(metadata: DispatchMetadata): Promise<ReturnType<typeof parseAgentSpec>> {
  const agent = await prisma.agent.findFirst({
    where: {
      id: metadata.agentId,
      ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    },
    select: {
      id: true,
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
    const spec = await loadAgentSpec(metadata);
    const fallbackVoice = process.env.OPENAI_REALTIME_VOICE ?? 'marin';

    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        voice: resolveRealtimeVoice(spec, fallbackVoice),
      }),
    });

    await session.start({
      agent: new VoiceForgeAgent(buildVoiceForgeInstructions(spec, metadata)),
      room: ctx.room,
    });

    await ctx.connect();
    await session.generateReply({
      instructions: firstReplyInstruction(spec),
    });
  },
});

const agentName = process.env.LIVEKIT_AGENT_NAME ?? 'voiceforge-agent';

cli.runApp(new ServerOptions({
  agent: fileURLToPath(import.meta.url),
  agentName,
}));
