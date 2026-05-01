import { Module } from '@nestjs/common';
import { WorkspaceGuard } from '../common/workspace.guard';
import { GoogleCalendarExecutor } from './executors/google-calendar.executor';
import { ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';
import { WebhookExecutor } from './webhook-executor';

@Module({
  controllers: [ToolsController],
  providers: [ToolsService, WebhookExecutor, GoogleCalendarExecutor, WorkspaceGuard],
  exports: [ToolsService],
})
export class ToolsModule {}
