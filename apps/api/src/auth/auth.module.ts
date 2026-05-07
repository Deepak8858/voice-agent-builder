import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MeController } from './me.controller';
import { InternalAuthGuard } from './internal-auth.guard';
import { SupabaseAuthService } from './supabase-auth.service';

@Global()
@Module({
  imports: [PrismaModule, CacheModule],
  controllers: [MeController],
  providers: [
    SupabaseAuthService,
    {
      provide: APP_GUARD,
      useClass: InternalAuthGuard,
    },
  ],
  exports: [SupabaseAuthService],
})
export class AuthModule {}
