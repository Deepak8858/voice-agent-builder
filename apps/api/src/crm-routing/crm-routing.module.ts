import { Module } from '@nestjs/common';
import { CrmRoutingService } from './crm-routing.service';
import { CrmFanOutService } from './crm-fanout.service';
import { CrmRoutingController } from './crm-routing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [PrismaModule, ToolsModule],
  controllers: [CrmRoutingController],
  providers: [CrmRoutingService, CrmFanOutService],
  exports: [CrmRoutingService, CrmFanOutService],
})
export class CrmRoutingModule {}
