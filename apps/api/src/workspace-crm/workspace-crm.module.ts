import { Module } from '@nestjs/common';
import { WorkspaceCrmService } from './workspace-crm.service';
import { WorkspaceCrmController } from './workspace-crm.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ToolsModule } from '../tools/tools.module';

@Module({
  imports: [PrismaModule, ToolsModule],
  controllers: [WorkspaceCrmController],
  providers: [WorkspaceCrmService],
  exports: [WorkspaceCrmService],
})
export class WorkspaceCrmModule {}
