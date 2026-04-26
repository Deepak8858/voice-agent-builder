import { Injectable, NotFoundException } from '@nestjs/common';
import type { AgentSpec } from '@voiceforge/shared';
import { MVP_TEMPLATES } from '@voiceforge/shared';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.agentTemplate.findMany({
      where: { isPublic: true },
      orderBy: { name: 'asc' },
    });
    if (rows.length === 0) {
      return MVP_TEMPLATES.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description,
        industry: t.industry,
        agent_type: t.agent_type,
      }));
    }
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      description: r.description,
      industry: r.industry,
      agent_type: r.agentType,
    }));
  }

  async getBySlug(slug: string) {
    const row = await this.prisma.agentTemplate.findUnique({ where: { slug } });
    if (row) {
      return {
        slug: row.slug,
        name: row.name,
        description: row.description,
        industry: row.industry,
        agent_type: row.agentType,
        template_spec: row.templateSpec as unknown as AgentSpec,
      };
    }
    const seed = MVP_TEMPLATES.find((t) => t.slug === slug);
    if (!seed) throw new NotFoundException(`Template ${slug} not found`);
    return {
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      industry: seed.industry,
      agent_type: seed.agent_type,
      template_spec: seed.spec as AgentSpec,
    };
  }
}
