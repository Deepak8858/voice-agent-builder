import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { AppModule } from './app.module';
import { env } from './config/env';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';

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
    : [`http://localhost:${env.WEB_PORT}`];
  app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    maxAge: 86400,
  }));

  app.use(cookieParser());

  // Capture raw body for Stripe webhook signature verification
  // Note: express.raw() is not in @types/express; we use express.json() with verify instead
  // The Stripe webhook controller reads req.rawBody set by the verify callback
  const express = require('express');
  // Default to parsed JSON, but also capture raw body
  app.use(express.json({
    verify: (_req: Record<string, unknown>, _res: Record<string, unknown>, buf: Buffer) => {
      (_req as { rawBody: Buffer }).rawBody = buf;
    },
  }));

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((sig) => {
    process.on(sig, async () => {
      console.log(`[api] Received ${sig}, shutting down gracefully...`);
      await app.close();
      process.exit(0);
    });
  });

  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`[api] VoiceForge API ${process.env.APP_VERSION ?? 'dev'} | ${process.env.NODE_ENV ?? 'development'} | listening on http://localhost:${env.API_PORT}/api/v1`);
}

bootstrap().catch((err) => {
  console.error('[api] Fatal boot error:', err);
  process.exit(1);
});
