import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { env } from './config/env';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers
  app.use(helmet());

  // CORS — use ALLOWED_ORIGINS env var (comma-separated). In production,
  // ALLOWED_ORIGINS should be set to your frontend domains only.
  const allowedOrigins: string[] = env.ALLOWED_ORIGINS as unknown as string[];
  if (allowedOrigins.length > 0) {
    app.use(
      cors({
        origin: allowedOrigins,
        credentials: true,
      }),
    );
  }

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`[api] VoiceForge API listening on http://localhost:${env.API_PORT}/api/v1`);

  // Graceful shutdown — drain existing connections before exiting
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  for (const sig of signals) {
    process.on(sig, async () => {
      console.log(`\n[api] Received ${sig}, shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  }
}

bootstrap().catch((err) => {
  console.error('[api] Fatal boot error:', err);
  process.exit(1);
});
