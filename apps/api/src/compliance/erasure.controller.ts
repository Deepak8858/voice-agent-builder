import { Controller, Delete, Param, UseGuards, Post } from '@nestjs/common';
import { ErasureService } from './erasure.service';
import { WorkspaceGuard } from '../common/workspace.guard';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

@Controller()
export class ErasureController {
  constructor(private readonly erasure: ErasureService) {}

  // Contact erasure: customer-facing, requires workspace membership
  @Delete('v1/orgs/:orgId/contacts/:contactId/erasure')
  @UseGuards(WorkspaceGuard)
  async eraseContact(
    @Param('orgId') orgId: string,
    @Param('contactId') contactId: string,
  ) {
    return this.erasure.eraseContact(orgId, contactId);
  }

  // Organization deletion: internal admin only
  @Delete('admin/orgs/:orgId')
  @UseGuards(InternalAuthGuard)
  async eraseOrganization(@Param('orgId') orgId: string) {
    return this.erasure.eraseOrganization(orgId);
  }

  // User self-deletion
  @Delete('v1/users/me/erasure')
  async eraseUser(@CurrentUser() user: { id: string }) {
    return this.erasure.eraseUser(user.id);
  }
}