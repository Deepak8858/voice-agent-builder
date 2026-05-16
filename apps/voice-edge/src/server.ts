import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { handleStream } from './stream-handler.js';
import { envSchema } from './env.js';

const env = envSchema.parse(process.env);

const fastify = Fastify({
  logger: { level: env.LOG_LEVEL ?? 'info' },
});

await fastify.register(cors, { origin: false });
await fastify.register(websocket);

fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

// Fastify websocket handler — socket param is Node.js ws WebSocket
fastify.get('/stream/:sessionId', { websocket: true }, (socket, req) => {
  const params = req.params as { sessionId?: string };
  const sessionId = params?.sessionId;

  if (!sessionId) {
    socket.send(JSON.stringify({ error: 'sessionId required' }));
    socket.close();
    return;
  }

  fastify.log.info({ sessionId }, 'WebSocket connected');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleStream(socket as any, sessionId, env).catch((err: unknown) => {
    fastify.log.error({ err, sessionId }, 'Stream handler error');
    socket.close();
  });
});

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

await fastify.listen({ port: PORT, host: HOST });
fastify.log.info(`Voice edge listening on ${HOST}:${PORT}`);