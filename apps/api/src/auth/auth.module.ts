import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { MeController } from './me.controller';
import { AuthService } from './auth.service';
import { ClerkAuthService } from './clerk-auth.service';
import { MockAuthService } from './mock-auth.service';
import { env } from '../config/env';

@Global()
@Module({
  controllers: [AuthController, ClerkWebhookController, MeController],
  providers: [
    MockAuthService,
    ClerkAuthService,
    {
      provide: AuthService,
      inject: [MockAuthService, ClerkAuthService],
      useFactory: (mock: MockAuthService, clerk: ClerkAuthService): AuthService => {
        return env.AUTH_PROVIDER === 'clerk' ? clerk : mock;
      },
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}