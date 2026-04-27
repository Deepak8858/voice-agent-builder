import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspaceGuard } from '../common/workspace.guard';
import {
  ClientInvitesController,
  ClientWorkspacesController,
  InviteAcceptController,
  WhiteLabelController,
} from './white-label.controller';
import { WhiteLabelService } from './white-label.service';

@Module({
  imports: [AuthModule],
  controllers: [
    WhiteLabelController,
    ClientWorkspacesController,
    ClientInvitesController,
    InviteAcceptController,
  ],
  providers: [WhiteLabelService, WorkspaceGuard],
  exports: [WhiteLabelService],
})
export class WhiteLabelModule {}
