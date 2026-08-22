import { Module } from '@nestjs/common';
import { GoogleOAuthClient } from '../calendar/google-oauth.client';
import { GoogleConnectionController } from './google-connection.controller';
import { GoogleConnectionService } from './google-connection.service';

@Module({
  controllers: [GoogleConnectionController],
  providers: [GoogleConnectionService, GoogleOAuthClient],
  exports: [GoogleConnectionService],
})
export class GoogleConnectionModule {}
