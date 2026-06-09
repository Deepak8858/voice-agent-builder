import { Module } from '@nestjs/common';
import { WorkspaceCrmService } from './workspace-crm.service';
import { WorkspaceCrmController } from './workspace-crm.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ToolsModule } from '../tools/tools.module';
import { AuditModule } from '../audit/audit.module';
import { SecurityModule } from '../security/security.module';

@Module({
  imports: [PrismaModule, ToolsModule, AuditModule, SecurityModule],
  controllers: [WorkspaceCrmController],
  providers: [WorkspaceCrmService],
  exports: [WorkspaceCrmService],
})
export class WorkspaceCrmModule {}
