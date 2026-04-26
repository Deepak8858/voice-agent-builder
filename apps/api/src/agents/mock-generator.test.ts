import { describe, expect, it } from 'vitest';
import { AgentSpecSchema, MVP_TEMPLATES } from '@voiceforge/shared';
import { MockAgentGeneratorService } from './mock-generator.service';

describe('MockAgentGeneratorService', () => {
  const generator = new MockAgentGeneratorService();

  it('produces a valid spec for every MVP template', () => {
    for (const t of MVP_TEMPLATES) {
      const result = generator.generate({
        prompt: t.test_prompts[0] ?? `Use the ${t.slug} template.`,
        template_slug: t.slug,
      });
      expect(result.matched_template_slug).toBe(t.slug);
      expect(AgentSpecSchema.safeParse(result.spec).success).toBe(true);
    }
  });

  it('auto-picks the dental template from a dental prompt', () => {
    const result = generator.generate({
      prompt:
        'Create an AI receptionist for a dental clinic that books appointments and transfers bleeding emergencies.',
      business_context: { business_name: 'Smile Dental Clinic', timezone: 'America/Los_Angeles' },
    });
    expect(result.matched_template_slug).toBe('dental-receptionist');
    expect(result.spec.identity.business_name).toBe('Smile Dental Clinic');
    expect(result.spec.handoff.conditions).toContain('bleeding');
  });

  it('propagates booking keyword into tools and goals', () => {
    const result = generator.generate({
      prompt: 'I want an agent that can book appointments for a gym.',
    });
    expect(result.spec.tools.some((t) => t.name === 'google_calendar.book_slot')).toBe(true);
    expect(result.spec.goals.some((g) => g.toLowerCase().includes('book'))).toBe(true);
  });

  it('forces compliance flags when the prompt mentions opt-out and recording', () => {
    const result = generator.generate({
      prompt:
        'Outbound appointment reminder. Record the call and honour do not call / opt-out requests.',
      template_slug: 'appointment-reminder',
    });
    expect(result.spec.compliance.opt_out_enabled).toBe(true);
    expect(result.spec.compliance.recording_notice_required).toBe(true);
  });
});
