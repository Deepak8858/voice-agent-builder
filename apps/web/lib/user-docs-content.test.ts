import { describe, expect, it } from 'vitest';
import {
  agentSpecReference,
  dashboardDocumentation,
  firstWorkingDemoSteps,
  userDocsConcepts,
  userDocsTroubleshooting,
} from './user-docs-content';

describe('user docs content', () => {
  it('documents the first working demo from signup through white label', () => {
    const stepText = firstWorkingDemoSteps.map((step) => step.title.toLowerCase()).join(' ');

    expect(firstWorkingDemoSteps).toHaveLength(9);
    expect(stepText).toContain('sign up');
    expect(stepText).toContain('workspace');
    expect(stepText).toContain('generate');
    expect(stepText).toContain('agent spec');
    expect(stepText).toContain('test call');
    expect(stepText).toContain('publish');
    expect(stepText).toContain('transcript');
    expect(stepText).toContain('analytics');
    expect(stepText).toContain('white-label');
  });

  it('covers every major dashboard area exposed in navigation', () => {
    const documentedRoutes = dashboardDocumentation.flatMap((group) =>
      group.items.map((item) => item.href),
    );

    expect(documentedRoutes).toEqual(
      expect.arrayContaining([
        '/dashboard/agents',
        '/dashboard/agents/new',
        '/dashboard/templates',
        '/dashboard/calls',
        '/dashboard/settings/phone-numbers',
        '/dashboard/campaigns',
        '/dashboard/knowledge',
        '/dashboard/integrations',
        '/dashboard/analytics',
        '/dashboard/clients',
        '/dashboard/compliance',
        '/dashboard/white-label',
        '/dashboard/billing',
        '/dashboard/settings',
      ]),
    );
  });

  it('explains Agent Spec JSON as the central contract', () => {
    const fields = agentSpecReference.map((section) => section.key);

    expect(fields).toEqual(
      expect.arrayContaining([
        'identity',
        'voice',
        'goals',
        'conversation_rules',
        'knowledge',
        'tools',
        'handoff',
        'compliance',
        'analytics',
        'flow',
      ]),
    );
    expect(userDocsConcepts.some((concept) => concept.title.includes('Agent Spec JSON'))).toBe(true);
  });

  it('includes compliance and troubleshooting guidance for risky workflows', () => {
    const conceptText = userDocsConcepts.map((concept) => concept.body).join(' ');
    const troubleshootingText = userDocsTroubleshooting
      .flatMap((item) => [item.problem, item.fix])
      .join(' ');

    expect(conceptText).toContain('No outbound call');
    expect(conceptText).toContain('workspace');
    expect(troubleshootingText).toContain('validation');
    expect(troubleshootingText).toContain('transcript');
  });
});
