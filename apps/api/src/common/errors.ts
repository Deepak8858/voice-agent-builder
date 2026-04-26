import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode } from '@voiceforge/shared';

/**
 * Base error class for VoiceForge. Carries a structured error code aligned
 * with docs/09_BACKEND_SPEC.md "Error Codes".
 */
export class AppError extends HttpException {
  constructor(
    public readonly errorCode: ApiErrorCode,
    public override readonly message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
    public readonly details?: Record<string, unknown>,
  ) {
    super({ code: errorCode, message, details }, status);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super('UNAUTHORIZED', message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.') {
    super('FORBIDDEN', message, HttpStatus.FORBIDDEN);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed.', details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, HttpStatus.BAD_REQUEST, details);
  }
}

export class WorkspaceNotFoundError extends AppError {
  constructor(workspaceId: string) {
    super('WORKSPACE_NOT_FOUND', `Workspace ${workspaceId} not found.`, HttpStatus.NOT_FOUND, {
      workspaceId,
    });
  }
}

export class AgentNotFoundError extends AppError {
  constructor(agentId: string) {
    super('AGENT_NOT_FOUND', `Agent ${agentId} not found.`, HttpStatus.NOT_FOUND, { agentId });
  }
}

export class AgentSpecInvalidError extends AppError {
  constructor(details: Record<string, unknown>) {
    super('AGENT_SPEC_INVALID', 'Agent Spec JSON is invalid.', HttpStatus.BAD_REQUEST, details);
  }
}

export class KnowledgeSourceNotFoundError extends AppError {
  constructor(sourceId: string) {
    super(
      'KNOWLEDGE_SOURCE_NOT_FOUND',
      `Knowledge source ${sourceId} not found.`,
      HttpStatus.NOT_FOUND,
      { sourceId },
    );
  }
}

export class KnowledgeFileInvalidError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('KNOWLEDGE_FILE_INVALID', message, HttpStatus.BAD_REQUEST, details);
  }
}

export class KnowledgeIngestFailedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('KNOWLEDGE_INGEST_FAILED', message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

export class CallNotFoundError extends AppError {
  constructor(callId: string) {
    super('CALL_NOT_FOUND', `Call ${callId} not found.`, HttpStatus.NOT_FOUND, { callId });
  }
}

export class AgentNotPublishedError extends AppError {
  constructor(agentId: string) {
    super(
      'AGENT_NOT_PUBLISHED',
      `Agent ${agentId} must be published to start outbound calls.`,
      HttpStatus.BAD_REQUEST,
      { agentId },
    );
  }
}

export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super('NOT_IMPLEMENTED', `${feature} is not implemented yet.`, HttpStatus.NOT_IMPLEMENTED);
  }
}

export class ToolNotFoundError extends AppError {
  constructor(toolId: string) {
    super('TOOL_NOT_FOUND', `Tool ${toolId} not found.`, HttpStatus.NOT_FOUND, { toolId });
  }
}

export class ToolInputInvalidError extends AppError {
  constructor(details: Record<string, unknown>) {
    super('TOOL_INPUT_INVALID', 'Tool input failed schema validation.', HttpStatus.BAD_REQUEST, details);
  }
}

export class ToolExecutionFailedError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('TOOL_EXECUTION_FAILED', message, HttpStatus.BAD_GATEWAY, details);
  }
}

export class ContactNotFoundError extends AppError {
  constructor(idOrPhone: string) {
    super('NOT_FOUND', `Contact ${idOrPhone} not found.`, HttpStatus.NOT_FOUND, { idOrPhone });
  }
}

export class ConsentNotFoundError extends AppError {
  constructor(consentType: string, contactId: string) {
    super(
      'NOT_FOUND',
      `No active ${consentType} consent record for contact ${contactId}.`,
      HttpStatus.NOT_FOUND,
      { consentType, contactId },
    );
  }
}

export class ComplianceBlockedError extends AppError {
  constructor(details: { reasons: Array<{ code: string; message: string; severity?: string }> }) {
    super(
      'COMPLIANCE_BLOCKED',
      'Compliance check blocked this call.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      details,
    );
  }
}
