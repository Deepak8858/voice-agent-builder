import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { PostHogService } from './posthog/posthog.service';
import { RequestLoggingMiddleware } from './common/request-logging.middleware';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';
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

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', env.TRUST_PROXY_HOPS);

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
  const allowedOrigins = env.ALLOWED_ORIGINS.length > 0
    ? env.ALLOWED_ORIGINS
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
  // Widen the JSON parser to webhook media types. `rawBody: true` above makes Nest
  // attach the untouched request buffer as `req.rawBody` (needed for Stripe/Twilio
  // signature verification).
  app.useBodyParser('json', {
    type: ['application/json', 'application/*+json', 'application/webhook+json'],
  });

  app.useGlobalFilters(new HttpExceptionFilter(app.get(PostHogService)));
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  const requestLoggingMiddleware = new RequestLoggingMiddleware();
  app.use(requestLoggingMiddleware.use.bind(requestLoggingMiddleware));

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((sig) => {
    process.on(sig, async () => {
      logger.info({ signal: sig }, 'Shutdown signal received, closing gracefully');
      await app.close();
      process.exit(0);
    });
  });

  const server = await app.listen(env.API_PORT ?? 4000, '0.0.0.0');
  const keepAliveTimeoutMs = Number(process.env.API_KEEP_ALIVE_TIMEOUT_MS ?? 65_000);
  const headersTimeoutMs = Number(process.env.API_HEADERS_TIMEOUT_MS ?? keepAliveTimeoutMs + 5_000);
  if ('keepAliveTimeout' in server) {
    server.keepAliveTimeout = keepAliveTimeoutMs;
  }
  if ('headersTimeout' in server) {
    server.headersTimeout = headersTimeoutMs;
  }
  logger.info({ port: env.API_PORT ?? 4000, env: process.env.NODE_ENV ?? 'development', version: process.env.APP_VERSION ?? 'dev' }, 'VoiceForge API started');
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal bootstrap error');
  process.exit(1);
});
