import { isDeepStrictEqual as same } from 'node:util';
import type { AuditInput, AuditorSession } from '../../contracts/audit.js';
import type { ArtifactRef } from '../../contracts/preparation.js';
import type { CodexRpc } from '../../contracts/codex.js';
import type { LocalProjectRegistration } from '../../activities/preparation.js';
import { exactFields, object, requireContract, text } from '../../contracts/project.js';
import { artifactStore, digest } from '../artifacts/files.js';
import {
  parseAuditCard,
  parseAuditInput,
  parseAuditReport,
  auditWorkflowKey,
} from '../../policy/audit.js';
import { readerKey, readerTarget, controlRef } from '../../policy/readerControl.js';
import { confirmAuditorInputs } from './auditInputs.js';
import {
  nativeAuditCalls,
  auditChildTurn,
  confirmAuditDelivery,
  confirmAuditorSession,
} from './nativeAudit.js';
import { confirmObservedLoad } from './observedLoad.js';
import { readerSession } from './readerSession.js';
import { auditParentProfile, auditorProfile } from './nativeAudit.js';
import { readerContextCompacted } from './readerContext.js';

export async function observeAuditProof(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: AuditInput,
  session: AuditorSession,
  load: ArtifactRef,
  question: ArtifactRef,
  parentTurn: string,
): Promise<ArtifactRef | null> {
  const store = artifactStore(registration.artifactRoot);
  const save = (v: unknown) => store.publish(Buffer.from(JSON.stringify(v)));
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const confirmed = confirmAuditorInputs(registration, input);
  const boundQuestion = read(question);
  requireContract(
    boundQuestion.kind === 'native-audit-card' &&
      same(boundQuestion.originalCard, input.card) &&
      same(boundQuestion.facts, read(input.card)),
    'task-audit-question-binding',
  );
  async function parentThread(id: string) {
    const t = object(
      object(await rpc.request('thread/read', { threadId: id, includeTurns: true })).thread,
    );
    requireContract(
      t.id === id && t.cwd === registration.workspaceRoot && Array.isArray(t.turns),
      'auditor-parent-history',
    );
    return t;
  }
  async function childThread(value: AuditorSession) {
    const t = object(
      object(await rpc.request('thread/read', { threadId: value.child, includeTurns: true }))
        .thread,
    );
    requireContract(
      t.id === value.child &&
        t.cwd === registration.workspaceRoot &&
        t.parentThreadId === value.parent.id &&
        t.agentRole === 'auditor' &&
        t.forkedFromId === null &&
        Array.isArray(t.turns),
      'auditor-child-identity',
    );
    return t;
  }
  async function nativeSession(value: AuditorSession) {
    const raw = await rpc.request('thread/resume', { threadId: value.child, excludeTurns: true });
    confirmAuditorSession(raw, value.parent.id, value.child, registration.workspaceRoot);
    return save({
      kind: 'auditor-native-session',
      method: 'thread/resume',
      request: { threadId: value.child, excludeTurns: true },
      response: raw,
    });
  }
  const parent = await parentThread(session.parent.id),
    calls = nativeAuditCalls(parent);
  requireContract(calls.length === 2, 'auditor-parent-call-count');
  const delivered = calls.find((c) => c.turn === parentTurn);
  requireContract(
    delivered !== undefined &&
      ['followup_task', 'collaboration.followup_task'].includes(delivered.name) &&
      delivered.args.target === session.path &&
      typeof delivered.args.message === 'string',
    'auditor-question-delivery',
  );
  requireContract(Object.keys(delivered.args).length === 2, 'auditor-question-delivery');
  const t = await childThread(session);
  if ((t.turns as unknown[]).length === 1) return null;
  const turn = auditChildTurn(t, parentTurn);
  if (turn.status === 'inProgress') return null;
  const delivery = confirmAuditDelivery(
    t,
    parentTurn,
    session.path,
    delivered.args.message,
    store.path(question),
  );
  const loaded = read(load),
    oldTurn = object(loaded.turn);
  requireContract(
    loaded.kind === 'auditor-load' &&
      same(loaded.input, input) &&
      same(loaded.session, session) &&
      same(loaded.preflight, input.preflight),
    'auditor-load-binding',
  );
  confirmObservedLoad(oldTurn, confirmed.refs);
  requireContract(
    (t.turns as unknown[]).length === 2 &&
      (t.turns as unknown[]).map(object).some((v) => same(v, oldTurn)) &&
      !readerContextCompacted({ thread: t }, session.child, text(oldTurn.id)),
    'auditor-context-unconfirmed',
  );
  confirmObservedLoad(turn, [{ path: store.path(question), sha256: question.sha256 }]);
  await nativeSession(session);
  requireContract(
    Array.isArray(turn.items) &&
      !turn.items
        .map(object)
        .some((i) => i.type === 'subAgentActivity' || i.type === 'collabAgentToolCall'),
    'auditor-delegation-forbidden',
  );
  const messages = turn.items
    .map(object)
    .filter((i) => i.type === 'agentMessage' && i.phase === 'final_answer');
  requireContract(
    messages.length === 1 && typeof messages[0]!.text === 'string',
    'auditor-report-required',
  );
  const body = read(question),
    facts = parseAuditCard(body.facts),
    report = parseAuditReport(JSON.parse(messages[0]!.text) as unknown, {
      ref: input.card,
      checkpoint: facts.checkpoint,
      sources: [...(body.allowedSources as string[]), store.path(question)],
    });
  return save({
    kind: 'auditor-answer',
    input,
    session,
    load,
    question,
    parentTurn,
    observed: turn,
    delivery,
    report,
  });
}

export async function verifyAuditResult(
  registration: LocalProjectRegistration,
  rpc: CodexRpc,
  input: AuditInput,
  result: ArtifactRef,
  stop: ArtifactRef,
) {
  parseAuditInput(input);
  const store = artifactStore(registration.artifactRoot);
  const read = (ref: ArtifactRef) => object(JSON.parse(store.read(ref).toString()) as unknown);
  const manifest = read(result),
    stopped = read(stop);
  requireContract(
    manifest.kind === 'audit-result' &&
      manifest.acceptance === false &&
      same(manifest.input, input),
    'task-audit-result-binding',
  );
  requireContract(
    stopped.kind === 'auditor-stopped' && stopped.confirmed === true && same(stopped.input, input),
    'task-audit-stop-required',
  );
  const raw = object(manifest.session),
    parent = object(raw.parent);
  exactFields(raw, ['parent', 'child', 'path', 'parentTurn']);
  exactFields(parent, ['id', 'creation']);
  const session: AuditorSession = {
    parent: { id: text(parent.id), creation: controlRef(parent.creation) },
    child: text(raw.child),
    path: text(raw.path),
    parentTurn: text(raw.parentTurn),
  };
  const creation = read(session.parent.creation);
  requireContract(
    creation.kind === 'auditor-parent' && same(creation.input, input),
    'auditor-parent-binding',
  );
  readerSession(
    creation.response,
    registration.workspaceRoot,
    auditParentProfile,
    session.parent.id,
  );
  const nativeParent = await rpc.request('thread/resume', {
    threadId: session.parent.id,
    excludeTurns: true,
  });
  readerSession(nativeParent, registration.workspaceRoot, auditParentProfile, session.parent.id);
  const answer = await observeAuditProof(
    registration,
    rpc,
    input,
    session,
    controlRef(manifest.load),
    controlRef(manifest.question),
    text(manifest.parentTurn),
  );
  requireContract(
    answer !== null && same(answer, controlRef(manifest.answer)),
    'task-audit-primary-unconfirmed',
  );
  const question = read(controlRef(manifest.question)),
    facts = parseAuditCard(question.facts);
  const report = parseAuditReport(read(answer).report, {
    ref: input.card,
    checkpoint: facts.checkpoint,
    sources: [...(question.allowedSources as string[]), store.path(controlRef(manifest.question))],
  });
  requireContract(same(report, manifest.report), 'task-audit-report-conflict');
  const parentThread = object(
    object(await rpc.request('thread/read', { threadId: session.parent.id, includeTurns: true }))
      .thread,
  );
  const child = object(
    object(await rpc.request('thread/read', { threadId: session.child, includeTurns: true }))
      .thread,
  );
  requireContract(
    parentThread.id === session.parent.id &&
      parentThread.cwd === registration.workspaceRoot &&
      child.id === session.child &&
      child.parentThreadId === session.parent.id &&
      child.cwd === registration.workspaceRoot &&
      Array.isArray(parentThread.turns) &&
      parentThread.turns.length === 2 &&
      parentThread.turns.map(object).every((t) => t.status === 'completed') &&
      Array.isArray(child.turns) &&
      child.turns.length === 2 &&
      child.turns.map(object).every((t) => t.status === 'completed'),
    'task-audit-not-stopped',
  );
  const calls = nativeAuditCalls(parentThread),
    launch = calls[0]!;
  exactFields(launch.args, ['task_name', 'agent_type', 'fork_turns', 'message']);
  requireContract(
    launch.turn === session.parentTurn &&
      launch.args.task_name === 'audit_' + digest(auditWorkflowKey(input)).slice(0, 48) &&
      launch.args.agent_type === 'auditor' &&
      launch.args.fork_turns === 'none' &&
      typeof launch.args.message === 'string',
    'task-audit-spawn-binding',
  );
  const started = parentThread.turns
    .map(object)
    .flatMap((t) => (t.items as unknown[]).map(object))
    .filter((i) => i.type === 'subAgentActivity' && i.kind === 'started');
  requireContract(
    started.length === 1 &&
      started[0]!.id === launch.id &&
      started[0]!.agentThreadId === session.child &&
      started[0]!.agentPath === session.path &&
      started[0]!.model === auditorProfile.model &&
      started[0]!.reasoningEffort === auditorProfile.effort,
    'task-audit-spawn-binding',
  );
  requireContract(
    Array.isArray(stopped.observations) &&
      stopped.observations.some((v) => {
        const proof = read(controlRef(v)),
          observed = object(proof.observed);
        return (
          proof.kind === 'auditor-child-stop' &&
          proof.child === session.child &&
          observed.id === session.child &&
          observed.parentThreadId === session.parent.id &&
          same(observed.turns, child.turns)
        );
      }),
    'task-audit-child-stop-unconfirmed',
  );
  const parentInput = {
    preparation: {
      ...input.preparation,
      taskId: 'audit_' + digest(auditWorkflowKey(input)).slice(0, 48),
    },
    roleId: 'auditor',
  };
  const parentStop = object(stopped.parentStop),
    receipt = read(controlRef(parentStop.receipt));
  requireContract(
    parentStop.status === 'stopped' &&
      receipt.kind === 'reader-stop' &&
      receipt.confirmed === true &&
      same(receipt.target, readerTarget(parentInput, readerKey(parentInput))),
    'task-audit-parent-stop-unconfirmed',
  );
  return {
    proof: store.publish(
      Buffer.from(
        JSON.stringify({
          kind: 'audit-verification',
          input,
          result,
          stop,
          answer,
          nativeParent,
          acceptance: false,
        }),
      ),
    ),
    report: { coverage: report.coverage, direction: report.direction },
  };
}
