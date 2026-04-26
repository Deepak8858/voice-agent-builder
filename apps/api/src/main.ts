import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { env } from './config/env';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/response-envelope.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: [`http://localhost:${env.WEB_PORT}`],
      credentials: true,
    },
  });

  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`[api] VoiceForge API listening on http://localhost:${env.API_PORT}/api/v1`);
}

bootstrap().catch((err) => {
  console.error('[api] Fatal boot error:', err);
  process.exit(1);
});
