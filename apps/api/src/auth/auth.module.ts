import { Global, Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { MeController } from './me.controller';
import { ClerkAuthService } from './clerk-auth.service';

@Global()
@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [AuthController, ClerkWebhookController, MeController],
  providers: [
    ClerkAuthService,
    { provide: 'AUTH_SERVICE', useExisting: ClerkAuthService },
  ],
  exports: [ClerkAuthService, 'AUTH_SERVICE'],
})
export class AuthModule {}