import { Injectable, Logger } from '@nestjs/common';

export interface CallSession {
  id: string;
  callSid: string;
  agentId: string;
  agentVersionId: string;
  workspaceId: string;
  direction: 'inbound' | 'outbound';
  status: 'initiating' | 'streaming' | 'ended';
  startedAt: Date;
  transcript: TranscriptSegment[];
  metadata: Record<string, unknown>;
}

export interface TranscriptSegment {
  speaker: 'agent' | 'caller';
  text: string;
  atMs: number;
}

@Injectable()
export class CallSessionManager {
  private readonly logger = new Logger(CallSessionManager.name);
  private readonly sessions = new Map<string, CallSession>();

  create(params: {
    callSid: string;
    agentId: string;
    agentVersionId: string;
    workspaceId: string;
    direction: 'inbound' | 'outbound';
    metadata?: Record<string, unknown>;
  }): CallSession {
    const session: CallSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      callSid: params.callSid,
      agentId: params.agentId,
      agentVersionId: params.agentVersionId,
      workspaceId: params.workspaceId,
      direction: params.direction,
      status: 'initiating',
      startedAt: new Date(),
      transcript: [],
      metadata: params.metadata ?? {},
    };
    this.sessions.set(session.id, session);
    this.logger.log(`Session created: ${session.id} for call ${params.callSid}`);
    return session;
  }

  get(id: string): CallSession | undefined {
    return this.sessions.get(id);
  }

  getByCallSid(callSid: string): CallSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.callSid === callSid) return s;
    }
    return undefined;
  }

  updateStatus(id: string, status: CallSession['status']): void {
    const s = this.sessions.get(id);
    if (s) s.status = status;
  }

  addTranscript(id: string, segment: TranscriptSegment): void {
    const s = this.sessions.get(id);
    if (s) s.transcript.push(segment);
  }

  end(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.status = 'ended';
      this.logger.log(`Session ended: ${id}, transcript segments: ${s.transcript.length}`);
    }
  }
}
