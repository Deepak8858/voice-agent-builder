import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '../common/errors';
import { LiveKitToolsController } from './livekit-tools.controller';

const CALL_ID = '11111111-1111-4111-8111-111111111111';

function makeController(call: { agentId: string; workspaceId: string } | null) {
  const prisma = {
    call: {
      findUnique: vi.fn(async () => call),
    },
  };
  const tools = {
    invokeByName: vi.fn(async () => ({
      status: 'success',
      response_body: { ok: true },
      error_message: null,
    })),
  };
  const controller = new LiveKitToolsController(prisma as never, tools as never);
  return { controller, prisma, tools };
}

describe('LiveKitToolsController', () => {
  it('derives workspace scope from the admitted call bound to the agent', async () => {
    const { controller, prisma, tools } = makeController({
      agentId: 'trusted-agent',
      workspaceId: 'trusted-workspace',
    });

    const result = await controller.invoke('trusted-agent', {
      tool_name: 'book_meeting',
      params: { operation: 'create_event' },
      call_id: CALL_ID,
      tool_type: 'google_calendar',
    });

    expect(prisma.call.findUnique).toHaveBeenCalledWith({
      where: { id: CALL_ID },
      select: { agentId: true, workspaceId: true },
    });
    expect(tools.invokeByName).toHaveBeenCalledWith(
      'trusted-workspace',
      'book_meeting',
      null,
      expect.objectContaining({ call_id: CALL_ID, agent_id: 'trusted-agent' }),
      'google_calendar',
    );
    expect(result).toEqual({ status: 'success', result: { ok: true }, error_message: null });
  });

  it("refuses a call bound to another workspace's agent", async () => {
    // The internal key is one credential for every tenant; the call binding is
    // what stops a key holder executing another workspace's tools by agent id.
    const { controller, tools } = makeController({
      agentId: 'other-workspace-agent',
      workspaceId: 'other-workspace',
    });

    await expect(
      controller.invoke('trusted-agent', {
        tool_name: 'book_meeting',
        params: {},
        call_id: CALL_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tools.invokeByName).not.toHaveBeenCalled();
  });

  it('refuses an unknown call id', async () => {
    const { controller, tools } = makeController(null);

    await expect(
      controller.invoke('trusted-agent', {
        tool_name: 'book_meeting',
        params: {},
        call_id: CALL_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(tools.invokeByName).not.toHaveBeenCalled();
  });
});
