import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { WebhookExecutor } from './webhook-executor';
import { GoogleCalendarExecutor } from './executors/google-calendar.executor';

@Module({
  controllers: [ToolsController],
  providers: [ToolsService, WebhookExecutor, GoogleCalendarExecutor, WorkspaceGuard],
  exports: [ToolsService],
})
export class ToolsModule {}
