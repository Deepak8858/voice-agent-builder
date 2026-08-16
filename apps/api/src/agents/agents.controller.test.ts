import { describe, expect, it, vi } from 'vitest';
import { AgentsController } from './agents.controller';

/**
 * Focused on the `generate` route: this PR moved it behind
 * GenerationRateLimitGuard and removed the SSE `generate/stream` route
 * (agents.controller.ts no longer exports a streaming endpoint). The guard
 * itself is covered by generation-rate-limit.guard.test.ts; here we only
 * verify the controller still delegates correctly to the service.
 */
function makeController() {
  const agents = {
    generate: vi.fn().mockResolvedValue({
      spec: { name: 'Generated Agent' },
      suggested_name: 'Generated Agent',
      rationale: 'Generated for tests.',
      matched_template_slug: 'ai-receptionist',
    }),
  };
  const prisma = {};
  return {
    controller: new AgentsController(agents as never, prisma as never),
    agents,
  };
}

const GENERATE_DTO = {
  prompt: 'Create a receptionist for a dental clinic',
  template_slug: undefined,
  business_context: undefined,
  knowledge_source_ids: [],
};

describe('AgentsController.generate', () => {
  it('delegates to AgentsService.generate with the workspace id and dto', async () => {
    const { controller, agents } = makeController();

    const result = await controller.generate('ws-1', GENERATE_DTO);

    expect(agents.generate).toHaveBeenCalledWith('ws-1', GENERATE_DTO);
    expect(result.suggested_name).toBe('Generated Agent');
  });

  it('propagates errors from the service (e.g. the 504 timeout envelope)', async () => {
    const { controller, agents } = makeController();
    const error = new Error('Agent generation timed out. Please try again.');
    agents.generate.mockRejectedValue(error);

    await expect(controller.generate('ws-1', GENERATE_DTO)).rejects.toThrow(
      'Agent generation timed out',
    );
  });

  it('no longer exposes a streaming generation route', () => {
    expect((AgentsController.prototype as Record<string, unknown>)['generateStream']).toBeUndefined();
  });
});