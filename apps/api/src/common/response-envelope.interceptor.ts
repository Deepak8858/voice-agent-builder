import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { SKIP_RESPONSE_ENVELOPE_KEY } from './decorators/skip-response-envelope.decorator';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = ctx.switchToHttp().getRequest<{ originalUrl?: string; url?: string; path?: string }>();
    const url = request.originalUrl ?? request.url ?? request.path ?? '';
    const skipEnvelope =
      Reflect.getMetadata(SKIP_RESPONSE_ENVELOPE_KEY, ctx.getHandler()) === true ||
      Reflect.getMetadata(SKIP_RESPONSE_ENVELOPE_KEY, ctx.getClass()) === true;
    if (skipEnvelope || url === '/api/v1/metrics' || url.endsWith('/metrics')) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => ({
        success: true,
        data: data ?? null,
        error: null,
      })),
    );
  }
}
