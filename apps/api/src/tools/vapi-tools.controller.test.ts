import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSpec } from '@voiceforge/shared';
import { VapiToolsController } from './vapi-tools.controller';

vi.mock('../config/env', () => ({
  env: { VAPI_WEBHOOK_SECRET: 'vapi-test-secret' },
}));

function publishedSpec(): AgentSpec {
  return {
    schema_version: '1.0',
    name: 'Google assistant',
    industry: 'services',
    agent_type: 'inbound_receptionist',
    language: 'en',
    voice: { tone: 'warm', allow_interruptions: true },
    identity: { business_name: 'Acme', agent_name: 'Ava' },
    goals: ['help callers'],
    required_fields: [],
    conversation_rules: {
      ask_one_question_at_a_time: true,
      confirm_critical_information: true,
      do_not_make_up_answers: true,
      fallback_to_human_when_unsure: true,
    },
    knowledge: { retrieval_mode: 'agent_scoped', max_chunks: 5, source_ids: [] },
    tools: [{
      name: 'send_email',
      description: 'Send an email',
      requires_confirmation: true,
      input_schema: {
        type: 'object',
        properties: { to: { type: 'string' } },
        required: ['to'],
      },
      permissions: ['gmail'],
    }],
    handoff: { enabled: true, conditions: ['caller_requests_human'] },
    compliance: {
      ai_disclosure_required: true,
      recording_notice_required: false,
      opt_out_enabled: true,
      consent_required_for_outbound: true,
    },
    analytics: { success_events: [] },
  };
}

function makeController() {
  const prisma = {
    agent: {
      findUnique: vi.fn(async () => ({
        workspaceId: 'workspace-from-db',
        activeVersionId: 'version-1',
        status: 'published',
      })),
    },
    agentVersion: {
      findUnique: vi.fn(async () => ({ specJson: publishedSpec() })),
    },
    call: {
      findFirst: vi.fn(async () => ({ id: '00000000-0000-4000-8000-000000000003' })),
    },
  };
  const tools = {
    invokeByName: vi.fn(async () => ({
      status: 'success',
      response_body: { message_id: 'msg-1' },
      error_message: null,
    })),
  };
  return {
    controller: new VapiToolsController(prisma as never, tools as never),
    prisma,
    tools,
  };
}

function payload(name = 'send_email') {
  return {
    message: {
      type: 'tool-calls',
      call: { id: 'vapi-call-1' },
      toolCallList: [{
        id: 'tool-call-1',
        name,
        arguments: { to: 'customer@example.test' },
      }],
      workspaceId: 'attacker-workspace',
    },
  };
}

describe('VapiToolsController', () => {
  it('rejects an invalid shared secret before database access', async () => {
    const { controller, prisma } = makeController();

    await expect(controller.invoke('agent-1', 'wrong-secret', payload()))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('derives tenant, tool type, agent, and internal call id from trusted records', async () => {
    const { controller, prisma, tools } = makeController();

    const response = await controller.invoke('agent-1', 'vapi-test-secret', payload());

    expect(prisma.call.findFirst).toHaveBeenCalledWith({
      where: { provider: 'vapi', providerCallId: 'vapi-call-1', agentId: 'agent-1' },
      select: { id: true },
    });
    expect(tools.invokeByName).toHaveBeenCalledWith(
      'workspace-from-db',
      'send_email',
      null,
      {
        arguments: { to: 'customer@example.test' },
        agent_id: 'agent-1',
        call_id: '00000000-0000-4000-8000-000000000003',
      },
      'gmail',
    );
    expect(response).toEqual({
      results: [{ toolCallId: 'tool-call-1', result: '{"message_id":"msg-1"}' }],
    });
  });

  it('does not dispatch a tool absent from the active published spec', async () => {
    const { controller, tools } = makeController();

    const response = await controller.invoke(
      'agent-1',
      'vapi-test-secret',
      payload('undeclared_tool'),
    );

    expect(tools.invokeByName).not.toHaveBeenCalled();
    expect(response.results[0]).toEqual({
      toolCallId: 'tool-call-1',
      error: 'Tool undeclared_tool is not authorized for this agent.',
    });
  });

  it('returns a single-line error while preserving HTTP-success response semantics', async () => {
    const { controller, tools } = makeController();
    tools.invokeByName.mockRejectedValueOnce(new Error('private token\nprovider detail'));

    const response = await controller.invoke('agent-1', 'vapi-test-secret', payload());

    expect(response).toEqual({
      results: [{ toolCallId: 'tool-call-1', error: 'Tool execution failed. Please try again.' }],
    });
  });

  it('accepts the parameters alias used by older Vapi payloads', async () => {
    const { controller, tools } = makeController();
    const body = payload();
    body.message.toolCallList = [{
      id: 'tool-call-1',
      name: 'send_email',
      parameters: { to: 'legacy@example.test' },
    }] as never;

    await controller.invoke('agent-1', 'vapi-test-secret', body);

    expect(tools.invokeByName).toHaveBeenCalledWith(
      'workspace-from-db',
      'send_email',
      null,
      expect.objectContaining({ arguments: { to: 'legacy@example.test' } }),
      'gmail',
    );
  });
});
