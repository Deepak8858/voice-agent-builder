import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = ctx.switchToHttp().getRequest<{ originalUrl?: string; url?: string; path?: string }>();
    const url = request.originalUrl ?? request.url ?? request.path ?? '';
    if (url === '/api/v1/metrics' || url.endsWith('/metrics')) {
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
