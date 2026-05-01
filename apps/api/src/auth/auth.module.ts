import { Global, Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { ClerkAuthService } from './clerk-auth.service';

@Global()
@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [AuthController, ClerkWebhookController],
  providers: [
    ClerkAuthService,
    { provide: AuthService, useExisting: ClerkAuthService },
  ],
  exports: [ClerkAuthService, AuthService],
})
export class AuthModule {}
