import { Module } from '@nestjs/common';
import { ComplianceModule } from '../compliance/compliance.module';
import { OutboundCampaignService } from './outbound-campaign.service';
import { OutboundCampaignController } from './outbound-campaign.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { WorkspaceGuard } from '../common/workspace.guard';

@Module({
  // ComplianceModule: campaign creation writes the consent attestation for the
  // whole contact list through ComplianceService.
  imports: [PrismaModule, QueueModule, ComplianceModule],
  controllers: [OutboundCampaignController],
  providers: [OutboundCampaignService, WorkspaceGuard],
  exports: [OutboundCampaignService],
})
export class OutboundCampaignModule {}
