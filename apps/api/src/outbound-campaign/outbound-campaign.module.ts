import { Module } from '@nestjs/common';
import { OutboundCampaignService } from './outbound-campaign.service';
import { OutboundCampaignController } from './outbound-campaign.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [OutboundCampaignController],
  providers: [OutboundCampaignService, WorkspaceGuard],
  exports: [OutboundCampaignService],
})
export class OutboundCampaignModule {}
