import { requireWorkflow, textField } from '../core/connection.js';
import {
  confirmSession,
  roleBrief,
  validateDataAnswer,
  validateDataQuery,
} from '../core/dataRoute.js';
import type { DataQuery, DataReading, SessionProfile } from '../core/dataRoute.js';
import { sameRefs } from '../core/council.js';
import { sameValue } from '../core/equality.js';
import type { EvidenceContext, StoredEvidence } from '../core/evidence.js';
import type { InputRef } from '../core/localRun.js';
import type { AgentSessions } from '../ports/agentSessions.js';
import type { EvidenceStore } from '../ports/evidenceStore.js';
import type { WorkflowInputs, WorkflowJournal } from '../ports/workflowJournal.js';

export async function directEvidence(
  store: EvidenceStore,
  context: EvidenceContext,
  id: string,
  revision: number | null,
): Promise<StoredEvidence> {
  const reply = await store.execute({ context, command: { type: 'read', id, revision } });
  requireWorkflow(reply.ok, 'direct-read-failed');
  return reply.value as StoredEvidence;
}
export class DataRoutes {
  constructor(
    private readonly journal: WorkflowJournal,
    private readonly sessions: AgentSessions,
    private readonly inputs: WorkflowInputs,
  ) {}
  private async put(reading: DataReading, expected: DataReading | null) {
    const state = await this.journal.read();
    requireWorkflow(
      sameValue(state.readings[reading.id] ?? null, expected),
      'data-revision-conflict',
    );
    const next = {
      ...state,
      revision: state.revision + 1,
      readings: { ...state.readings, [reading.id]: reading },
    };
    await this.journal.save(state, next, `data:${reading.id}:${next.revision}`);
    return reading;
  }
  private async get(id: string) {
    const reading = (await this.journal.read()).readings[id];
    requireWorkflow(reading !== undefined, 'data-reading-missing');
    return reading;
  }
  async start(
    id: string,
    query: DataQuery,
    profile: SessionProfile,
    restart: DataReading['restart'] = null,
  ): Promise<DataReading> {
    textField(id);
    textField(profile.reason);
    validateDataQuery(query);
    requireWorkflow(
      (await this.journal.read()).readings[id] === undefined,
      'data-reading-already-exists',
    );
    if (restart) {
      const previous = await this.get(restart.previous_id);
      requireWorkflow(
        previous.session === null || (await this.sessions.inspect(previous.session.id)) === null,
        'previous-session-recoverable',
      );
      await this.inputs.verify([restart.checkpoint]);
    }
    await this.inputs.verify([...query.sources, ...query.rules, ...query.procedures]);
    const reading: DataReading = {
      id,
      query,
      profile,
      phase: 'reserved',
      session: null,
      load: null,
      turn_id: null,
      creations: 1,
      answers: [],
      restart,
    };
    await this.put(reading, null);
    // An uncertain create leaves the reservation intact; start cannot silently retry it.
    const session = await this.sessions.create(profile);
    confirmSession(session, profile, true);
    const loading = await this.put({ ...reading, phase: 'loading', session }, reading);
    const load = await this.sessions.load(session, query);
    return this.put({ ...reading, phase: 'ready', session, load }, loading);
  }
  async send(id: string): Promise<DataReading> {
    const reading = await this.get(id);
    requireWorkflow(
      reading.phase === 'ready' && reading.session !== null && reading.load !== null,
      'data-not-ready',
    );
    await this.inputs.verify([
      ...reading.query.sources,
      ...reading.query.rules,
      ...reading.query.procedures,
    ]);
    const sending = await this.put(
      { ...reading, phase: 'sending', send_id: `${id}:${reading.answers.length}` },
      reading,
    );
    const turn = await this.sessions.send(
      reading.session,
      roleBrief(reading.query),
      sending.send_id!,
    );
    return this.put({ ...sending, phase: 'running', turn_id: turn }, sending);
  }
  async poll(id: string): Promise<DataReading> {
    const reading = await this.get(id);
    requireWorkflow(
      reading.phase === 'running' && reading.session !== null && reading.turn_id !== null,
      'data-not-running',
    );
    const result = await this.sessions.poll(reading.session, reading.turn_id);
    if (result.status === 'running') return reading;
    validateDataAnswer(reading, result.answer);
    await this.inputs.verify(reading.query.sources);
    return this.put(
      { ...reading, phase: 'answered', answers: [...reading.answers, result.answer] },
      reading,
    );
  }
  async followUp(id: string, query: DataQuery, reselected: InputRef | null): Promise<DataReading> {
    const reading = await this.get(id);
    requireWorkflow(
      reading.phase === 'answered' && reading.session !== null,
      'data-follow-up-not-ready',
    );
    const session = await this.sessions.inspect(reading.session.id);
    requireWorkflow(session !== null && session.id === reading.session.id, 'role-identity-lost');
    confirmSession(session, reading.profile, false);
    validateDataQuery(query);
    requireWorkflow(
      query.kind === reading.query.kind &&
        sameRefs(query.rules, reading.query.rules) &&
        sameRefs(query.procedures, reading.query.procedures),
      'follow-up-contract-changed',
    );
    if (!sameRefs(query.sources, reading.query.sources)) {
      requireWorkflow(reselected !== null, 'source-revision-changed');
      await this.inputs.verify([reselected]);
      if (query.kind === 'large-source')
        requireWorkflow(query.continuation === null, 'old-range-continuation');
    }
    await this.inputs.verify(query.sources);
    return this.put({ ...reading, query, session, phase: 'ready', turn_id: null }, reading);
  }
  async recover(
    id: string,
    sessionId: string,
    load: InputRef | null,
    turn: string | null,
  ): Promise<DataReading> {
    const reading = await this.get(id);
    requireWorkflow(
      ['reserved', 'loading', 'sending'].includes(reading.phase),
      'recovery-not-needed',
    );
    requireWorkflow(
      reading.session === null || reading.session.id === sessionId,
      'wrong-recovery-identity',
    );
    const session = await this.sessions.inspect(sessionId);
    requireWorkflow(session !== null, 'role-identity-lost');
    confirmSession(session, reading.profile, false);
    if (reading.phase === 'sending') {
      requireWorkflow(
        reading.send_id !== undefined && reading.load !== null,
        'send-outcome-unknown',
      );
      const found = await this.sessions.recoverSend(session, reading.send_id);
      requireWorkflow(found !== null && (turn === null || turn === found), 'send-outcome-unknown');
      await this.inputs.verify([reading.load]);
      return this.put({ ...reading, session, turn_id: found, phase: 'running' }, reading);
    }
    requireWorkflow(turn === null, 'recovery-load-missing');
    if (load === null) {
      const loading = await this.put({ ...reading, session, phase: 'loading' }, reading);
      const receipt = await this.sessions.load(session, reading.query);
      return this.put({ ...loading, load: receipt, phase: 'ready' }, loading);
    }
    await this.inputs.verify([load]);
    return this.put({ ...reading, session, load, turn_id: null, phase: 'ready' }, reading);
  }
}
