import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceGuard],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
