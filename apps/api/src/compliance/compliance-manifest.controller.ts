import { Controller, Get, UseGuards } from '@nestjs/common';
import { ComplianceManifestService } from './compliance-manifest.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';

@Controller('admin/compliance')
export class ComplianceManifestController {
  constructor(private readonly manifest: ComplianceManifestService) {}

  @Get('manifest')
  @UseGuards(InternalAuthGuard)
  async getManifest() {
    return this.manifest.generate();
  }
}
