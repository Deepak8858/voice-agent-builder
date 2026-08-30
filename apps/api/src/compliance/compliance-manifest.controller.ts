import { Controller, Get, UseGuards } from '@nestjs/common';
import { ComplianceManifestService } from './compliance-manifest.service';
import { InternalAuthGuard } from '../auth/internal-auth.guard';
import { InternalOnly } from '../common/decorators/internal-only.decorator';

/**
 * Operator-only compliance manifest. Without @InternalOnly() the Next.js
 * proxy would let any signed-in tenant user read it, since the proxy attaches
 * the internal key to whatever path the browser asks for.
 */
@InternalOnly()
@Controller('admin/compliance')
export class ComplianceManifestController {
  constructor(private readonly manifest: ComplianceManifestService) {}

  @Get('manifest')
  @UseGuards(InternalAuthGuard)
  async getManifest() {
    return this.manifest.generate();
  }
}
