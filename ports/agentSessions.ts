import type { AuditAttempts } from './auditAttempts.js';
import type { AgentSession, DataAnswer, DataQuery, SessionProfile } from '../core/dataRoute.js';
import type { InputRef } from '../core/localRun.js';
import type { CouncilReviewRequest, ReviewBinding } from '../core/council.js';

export interface CouncilSessions
  extends Pick<AgentSessions, 'inspect' | 'poll'>, Partial<AuditAttempts> {
  verifyReview(
    session: AgentSession,
    request: CouncilReviewRequest,
    turn: string,
    answer: InputRef,
  ): Promise<ReviewBinding>;
}

export interface AgentSessions {
  create(profile: SessionProfile): Promise<AgentSession>;
  inspect(id: string): Promise<AgentSession | null>;
  load(session: AgentSession, query: DataQuery): Promise<InputRef>;
  send(session: AgentSession, brief: string, requestId: string): Promise<string>;
  recoverSend(session: AgentSession, requestId: string): Promise<string | null>;
  poll(
    session: AgentSession,
    turn: string,
  ): Promise<{ status: 'running' } | { status: 'completed'; answer: DataAnswer }>;
}
