import { Controller, Get, Patch, Body } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionUser } from '../../common/decorators/session-user.decorator';

@Controller('auth')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  async me(@SessionUser() user: { id: string }) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { workspace: { select: { id: true, name: true, slug: true, type: true } } },
    });
    return {
      id: user.id,
      workspaces: memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
    };
  }
}