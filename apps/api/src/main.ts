import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { AppModule } from './app.module';
import { env } from './config/env';
import { logger } from './logging';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.setGlobalPrefix('api/v1');

  // Security headers
  const helmetResult = helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true },
    noSniff: true,
    frameguard: { action: 'deny' },
  });
  if (typeof helmetResult === 'function') {
    app.use(helmetResult);
  } else {
    logger.warn({ type: typeof helmetResult }, 'helmet() returned non-function, skipping');
  }

  // CORS
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [`http://localhost:${env.WEB_PORT ?? 3000}`];
  const corsResult = cors({
    origin: allowedOrigins,
    credentials: true,
    maxAge: 86400,
  });
  if (typeof corsResult === 'function') {
    app.use(corsResult);
  } else {
    logger.warn({ type: typeof corsResult }, 'cors() returned non-function, skipping');
  }

  const cpResult = cookieParser();
  if (typeof cpResult === 'function') {
    app.use(cpResult);
  } else {
    logger.warn({ type: typeof cpResult }, 'cookieParser() returned non-function, skipping');
  }

  // tracing.ts is imported as a side effect in app.module.ts — NodeSDK.start() runs during module init
  // OTel auto-instruments HTTP, Express, and Prisma; configure OTEL_EXPORTER_OTLP_ENDPOINT to send traces to a collector
  const express = require('express');
  app.use(express.json({
    verify: (_req: Record<string, unknown>, _res: Record<string, unknown>, buf: Buffer) => {
      (_req as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  app.useGlobalFilters(new (require('./common/http-exception.filter').HttpExceptionFilter)());
  app.useGlobalInterceptors(new (require('./common/response-envelope.interceptor').ResponseEnvelopeInterceptor)());
  app.use(new (require('./common/request-logging.middleware').RequestLoggingMiddleware)());

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((sig) => {
    process.on(sig, async () => {
      logger.info({ signal: sig }, 'Shutdown signal received, closing gracefully');
      await app.close();
      process.exit(0);
    });
  });

  await app.listen(env.API_PORT ?? 4000, '0.0.0.0');
  logger.info({ port: env.API_PORT ?? 4000, env: process.env.NODE_ENV ?? 'development', version: process.env.APP_VERSION ?? 'dev' }, 'VoiceForge API started');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal bootstrap error');
  process.exit(1);
});
