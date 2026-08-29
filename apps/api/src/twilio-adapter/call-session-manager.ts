import { randomUUID } from 'node:crypto';
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
      // The id is emitted to Twilio inside the `<Stream url="wss://.../voice/
      // stream/<id>">` TwiML, i.e. it is a bearer capability in a URL. It was
      // built from `Date.now()` and `Math.random()`: V8's PRNG state is
      // recoverable from a handful of outputs and the clock is not a secret, so
      // ids were predictable. `startedAt` already carries the timestamp the old
      // prefix encoded, and nothing parses this shape.
      id: `session_${randomUUID()}`,
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
