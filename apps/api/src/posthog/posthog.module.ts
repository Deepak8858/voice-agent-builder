import { Global, Module } from '@nestjs/common';
import { posthogConfigFromEnv } from './posthog.config';
import { PostHogService } from './posthog.service';

/**
 * Global so any service can capture without importing a module. The provider
 * resolves configuration once at boot; when PostHog is disabled or
 * unconfigured the service is constructed inert rather than omitted, so
 * injection sites never need a null check.
 */
@Global()
@Module({
  providers: [
    {
      provide: PostHogService,
      useFactory: () => new PostHogService(posthogConfigFromEnv()),
    },
  ],
  exports: [PostHogService],
})
export class PostHogModule {}
