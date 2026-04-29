import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { AppModule } from './app.module';
import { env } from './config/env';
import { logger } from './logging';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';
import { RequestLoggingMiddleware } from './common/request-logging.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.setGlobalPrefix('api/v1');

  // Security headers
  app.use(helmet({
    hsts: { maxAge: 31536000, includeSubDomains: true },
    noSniff: true,
    frameguard: { action: 'deny' },
  }));

  // CORS
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : [`http://localhost:${env.WEB_PORT ?? 3000}`];
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    maxAge: 86400,
  }));

  app.use(cookieParser());

  // tracing.ts is imported as a side effect in app.module.ts — NodeSDK.start() runs during module init
// OTel auto-instruments HTTP, Express, and Prisma; configure OTEL_EXPORTER_OTLP_ENDPOINT to send traces to a collector
  const express = require('express');
  app.use(express.json({
    verify: (_req: Record<string, unknown>, _res: Record<string, unknown>, buf: Buffer) => {
      (_req as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.use(new RequestLoggingMiddleware());

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
