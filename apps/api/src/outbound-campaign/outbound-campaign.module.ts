import { Module } from '@nestjs/common';
import { OutboundCampaignService } from './outbound-campaign.service';
import { OutboundCampaignController } from './outbound-campaign.controller';
import { OutboundCallWorker } from './workers/outbound-call.worker';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { TwilioModule } from '../twilio-adapter/twilio.module';

@Module({
  imports: [PrismaModule, QueueModule, TwilioModule],
  controllers: [OutboundCampaignController],
  providers: [OutboundCampaignService, OutboundCallWorker],
  exports: [OutboundCampaignService],
})
export class OutboundCampaignModule {}
