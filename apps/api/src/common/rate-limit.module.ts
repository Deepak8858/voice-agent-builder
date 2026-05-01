import { Global, Module, Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';

const globalRateLimitGuard: Provider = {
  provide: APP_GUARD,
  useClass: RateLimitGuard,
};

@Global()
@Module({
  providers: [RateLimitGuard, globalRateLimitGuard],
  exports: [RateLimitGuard],
})
export class RateLimitModule {}
