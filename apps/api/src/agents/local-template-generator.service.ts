import { Injectable } from '@nestjs/common';
import {
  AgentSpecSchema,
  findTemplateBySlug,
  MVP_TEMPLATES,
  type AgentSpec,
  type AgentTemplateSeed,
  type GenerateAgentDto,
  type GenerateAgentResult,
} from '@voiceforge/shared';
import { AgentSpecInvalidError } from '../common/errors';

/**
 * Deterministic, no-network prompt-to-agent generator. Given a prompt and an
 * optional template slug, it returns a valid Agent Spec JSON by merging
 * templates with keyword heuristics.
 *
 * This is a REAL local generator — not a mock. It works without any external
 * API key and is selectable via LLM_PROVIDER=local.
 *
 * Strategy:
 *   1. Pick a template (explicit slug wins; else keyword-match; else default).
 *   2. Merge business_context into identity.
 *   3. Apply light keyword heuristics to adjust goals / tools / handoff /
 *      compliance (e.g. "book" → add calendar tool, "opt out" → assert
 *      opt_out_enabled, etc).
 *   4. Parse through AgentSpecSchema to guarantee the output is valid.
 */
@Injectable()
export class LocalTemplateAgentGenerator {
  readonly name = 'local';
  async generate(input: GenerateAgentDto): Promise<GenerateAgentResult> {
    const template = this.pickTemplate(input);
    const base = structuredClone(template.spec) as AgentSpec;

    if (input.business_context?.business_name) {
      base.identity.business_name = input.business_context.business_name;
      base.name = `${input.business_context.business_name} \u2014 ${template.name}`;
      base.identity.disclosure = `Hi, this is ${base.identity.agent_name}, the AI agent for ${input.business_context.business_name}.`;
    }
    if (input.business_context?.timezone && base.compliance.allowed_call_window) {
      base.compliance.allowed_call_window.timezone = input.business_context.timezone;
    }
    if (input.business_context?.industry_hint) {
      base.industry = input.business_context.industry_hint;
    }

    this.applyKeywordHeuristics(base, input.prompt.toLowerCase());

    const sourceIds = input.knowledge_source_ids ?? [];
    if (sourceIds.length > 0) {
      base.knowledge.source_ids = Array.from(
        new Set([...(base.knowledge.source_ids ?? []), ...sourceIds]),
      );
      if (base.knowledge.retrieval_mode === 'none') {
        base.knowledge.retrieval_mode = 'agent_scoped';
      }
      if ((base.knowledge.max_chunks ?? 0) === 0) {
        base.knowledge.max_chunks = 5;
      }
    } else if (/\b(faq|docs?|policy|policies|pricing|hours|knowledge|handbook)\b/.test(input.prompt.toLowerCase())) {
      if (base.knowledge.retrieval_mode === 'none') {
        base.knowledge.retrieval_mode = 'agent_scoped';
      }
      if ((base.knowledge.max_chunks ?? 0) === 0) {
        base.knowledge.max_chunks = 5;
      }
    }

    const parsed = AgentSpecSchema.safeParse(base);
    if (!parsed.success) {
      throw new AgentSpecInvalidError({ issues: parsed.error.flatten() });
    }

    return {
      spec: parsed.data,
      suggested_name: parsed.data.name,
      rationale: this.buildRationale(template, input.prompt),
      matched_template_slug: template.slug,
    };
  }

  private pickTemplate(input: GenerateAgentDto): AgentTemplateSeed {
    if (input.template_slug) {
      const byArg = findTemplateBySlug(input.template_slug);
      if (byArg) return byArg;
    }
    const lower = input.prompt.toLowerCase();
    const scored = MVP_TEMPLATES.map((t) => ({
      t,
      score: this.scoreTemplate(t, lower),
    })).sort((a, b) => b.score - a.score);
    return scored[0]?.t ?? MVP_TEMPLATES[0]!;
  }

  private scoreTemplate(t: AgentTemplateSeed, prompt: string): number {
    let s = 0;
    const hay = `${t.slug} ${t.name} ${t.description} ${t.industry} ${t.agent_type}`.toLowerCase();
    for (const word of hay.split(/\W+/).filter((w) => w.length > 3)) {
      if (prompt.includes(word)) s += 1;
    }
    // Strong hints.
    if (prompt.includes('dental') || prompt.includes('dentist')) s += t.slug === 'dental-receptionist' ? 10 : 0;
    if (prompt.includes('real estate') || prompt.includes('property')) s += t.slug === 'real-estate-qualifier' ? 10 : 0;
    if (prompt.includes('reminder')) s += t.slug === 'appointment-reminder' ? 10 : 0;
    if (prompt.includes('cod') || prompt.includes('order confirmation')) s += t.slug === 'd2c-order-confirmation' ? 10 : 0;
    if (prompt.includes('receptionist')) s += t.slug === 'ai-receptionist' ? 3 : 0;
    return s;
  }

  private applyKeywordHeuristics(spec: AgentSpec, prompt: string): void {
    // Booking / calendar
    if (prompt.match(/\b(book|booking|appointment|schedule)\b/)) {
      const has = spec.tools.some((t) => t.name === 'google_calendar.book_slot');
      if (!has) {
        spec.tools.push({
          name: 'google_calendar.book_slot',
          description: 'Book an appointment on the calendar.',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            properties: {
              full_name: { type: 'string' },
              phone: { type: 'string' },
              preferred_date: { type: 'string' },
              preferred_time: { type: 'string' },
            },
            required: ['full_name', 'phone'],
          },
        });
      }
      if (!spec.goals.some((g) => g.toLowerCase().includes('book'))) {
        spec.goals.push('book appointments');
      }
    }

    // Transfer to human
    if (prompt.match(/\b(transfer|handoff|escalat|human)\b/)) {
      spec.handoff.enabled = true;
      for (const cond of ['caller_requests_human', 'urgent_case', 'agent_uncertain']) {
        if (!spec.handoff.conditions.includes(cond)) spec.handoff.conditions.push(cond);
      }
    }

    // Opt-out / compliance reinforcement
    if (prompt.match(/\b(opt[- ]?out|do not call|unsubscribe)\b/)) {
      spec.compliance.opt_out_enabled = true;
    }

    // Recording
    if (prompt.match(/\b(record|recording)\b/)) {
      spec.compliance.recording_notice_required = true;
    }

    // Emergency transfer for clinical prompts
    if (prompt.match(/\b(emergency|urgent|bleeding|severe pain)\b/)) {
      for (const cond of ['severe_pain', 'bleeding', 'urgent_case']) {
        if (!spec.handoff.conditions.includes(cond)) spec.handoff.conditions.push(cond);
      }
    }

    // SMS follow-up
    if (prompt.match(/\b(sms|text|follow[- ]?up)\b/)) {
      if (!spec.goals.some((g) => g.toLowerCase().includes('sms'))) {
        spec.goals.push('send SMS follow-up');
      }
    }
  }

  private buildRationale(template: AgentTemplateSeed, prompt: string): string {
    return `Matched template "${template.name}" from your prompt. Merged business context and applied keyword heuristics (booking, transfer, opt-out, recording, knowledge). Attached knowledge sources are referenced in spec.knowledge.source_ids. Review the Agent Spec JSON and tweak required fields, tools, or handoff conditions before publishing. (Prompt length: ${prompt.length} chars.)`;
  }
}
