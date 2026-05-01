import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { ClerkAuthService } from './clerk-auth.service';

@Global()
@Module({
  controllers: [AuthController, ClerkWebhookController],
  providers: [ClerkAuthService],
  exports: [ClerkAuthService],
})
export class AuthModule {}
