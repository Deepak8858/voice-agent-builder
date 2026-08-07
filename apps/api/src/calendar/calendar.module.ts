import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarController } from './calendar.controller';
import { GoogleOAuthClient } from './google-oauth.client';

@Module({
  controllers: [CalendarController],
  providers: [CalendarService, GoogleOAuthClient],
  exports: [CalendarService],
})
export class CalendarModule {}
