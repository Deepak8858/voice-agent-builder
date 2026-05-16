import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { AppModule } from './app.module';
import { env, isProduction } from './config/env';
import { logger } from './logging';

// HIPAA/SOC2: refuse to boot without ENCRYPTION_KEY in production
if (isProduction() && !env.ENCRYPTION_KEY) {
  logger.fatal('ENCRYPTION_KEY must be set in production — refusing to boot');
  process.exit(1);
}

if (!isProduction() && !env.ENCRYPTION_KEY) {
  logger.warn('ENCRYPTION_KEY not set. Encryption disabled in dev mode.');
}

async function bootstrap() {
  // Fail fast: JWT_SECRET must be secure in production
  if (isProduction() && env.JWT_SECRET === 'change-me-in-development') {
    logger.fatal({}, 'FATAL: JWT_SECRET must be set to a secure 32+ character string in production');
    process.exit(1);
  }

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
  if (isProduction() && allowedOrigins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must be explicitly set in production.');
  }
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
  const requestLoggingMiddleware = new (require('./common/request-logging.middleware').RequestLoggingMiddleware)();
  app.use((req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => requestLoggingMiddleware.use(req as never, res as never, next as never));

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
