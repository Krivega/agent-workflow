import { join } from 'node:path';
import suiteSource from './fixtures/qualification/suite.json' with { type: 'json' };
import materialSource from './fixtures/qualification/materials.json' with { type: 'json' };
import { canonical, digest } from '../adapters/storage/storeCodec.js';
import { parseComparisonMaterials, parseComparisonSuite } from '../core/comparison.js';
import { object, requireWorkflow } from '../core/connection.js';
import {
  applyLocalEvent,
  localRunVersionSupported,
  type InputRef,
  type LocalEvent,
  type LocalRun,
} from '../core/localRun.js';
import type { AgentSession, DataQuery } from '../core/dataRoute.js';
import { validateDataAnswer } from '../core/dataRoute.js';
import type { DataAnswer, DataReading } from '../core/dataRoute.js';
import { decodeChatArtifact } from '../adapters/storage/sharedArtifacts.js';
import { confirmNativeRead } from '../adapters/codex/nativeRead.js';
import { h01ReadJson, h01ReadPin, h01RawFile } from './comparisonH01Contract.js';

const suite = parseComparisonSuite(suiteSource);
export const h05Scenario = Object.freeze(suite.scenarios.find((row) => row.id === 'H-05')!);
export const h05Material = parseComparisonMaterials(materialSource, suite).find(
  (row) => row.id === 'H-05',
)!;
Object.freeze(h05Scenario.checks);
Object.freeze(h05Material.files);
Object.freeze(h05Material.mutable);
Object.freeze(h05Material);
export const h05Procedures = [
  'bootstrap',
  'data-roles',
  'task',
  'evidence',
  'boundary-review',
] as const;
export const h05ProbeIds = [
  'pre-subscription',
  'delivery-recovered',
  'deduplicated',
  'reordered',
  'restart-reconciled',
  'owner-fenced',
  'late-cancel-refused',
] as const;
export type H05ProbeId = (typeof h05ProbeIds)[number];
export function h05PreparedMetadata(
  rules: string,
  executor: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    '.h05/rules.md': rules,
    '.h05/task.md': h05Material.instructions + '\n',
    '.h05/executor.md':
      'Read-only H05 known-turn reader. One initial native turn only. Never repeat create/send, change permissions, clear F-01, or apply a cancelled or stale-generation result.\n' +
      executor,
  });
}
export interface H05Binding {
  kind: 'comparison-h05-binding';
  schemaVersion: 1;
  opId: string;
  requestHash: string;
  engine: 'legacy' | 'temporal';
  identity: { taskId: string; owner: string; generation: number };
  material: InputRef;
  failure: InputRef;
  workspace: string;
  stateRoot: string;
  evidenceRoot: string;
  session: AgentSession;
  turn: string;
  deliveryId: string;
  query: DataQuery;
  nativeTranscript: string;
}
export interface H05WaitExecution {
  id: H05ProbeId;
  binding: InputRef;
  mode: 'wait' | 'cancel' | 'restart';
}
export interface H05WaitResult {
  outcome: 'completed' | 'cancelled';
  result: InputRef | null;
  evidence: InputRef[];
}
export type H05WaitExecutor = (
  input: H05WaitExecution,
  wait: (signal: AbortSignal) => Promise<InputRef>,
) => Promise<H05WaitResult>;
export interface H05Probe {
  before: InputRef;
  after: InputRef;
  basis: InputRef;
  observation: InputRef;
  reads: InputRef[];
  execution: H05WaitResult | null;
  result: InputRef | null;
}
export interface H05CaseReport {
  kind: 'comparison-h05-case';
  scenario: 'H-05';
  opId: string;
  engine: 'legacy' | 'temporal';
  session: string | null;
  turn: string | null;
  outcome: 'accepted' | 'failed' | 'unknown' | 'not-run';
  checks: Record<string, boolean>;
  blocking: string[];
  binding: InputRef | null;
  initial: { failure: InputRef | null; load: InputRef | null; state: InputRef | null };
  native: {
    primary: InputRef | null;
    prefixBefore: InputRef | null;
    prefixAfter: InputRef | null;
    journals: InputRef[];
  };
  probes: Partial<Record<H05ProbeId, H05Probe>>;
  restart: {
    waiting: InputRef | null;
    detached: InputRef | null;
    resumed: InputRef | null;
    state: InputRef | null;
  };
  retained: { before: InputRef | null; after: InputRef | null };
  stop: InputRef;
  evidence: InputRef[];
  nativeAcceptance: false;
  qualification: false;
  partialScope: true;
}
function same(a: unknown, b: unknown) {
  return canonical(a) === canonical(b);
}
function json(ref: InputRef | null) {
  requireWorkflow(ref !== null, 'h05-primary-missing');
  return object(h01ReadJson(ref));
}
export function h05WireJournal(path: string) {
  const text = h01RawFile(path).toString('utf8');
  requireWorkflow(text === '' || text.endsWith('\n'), 'h05-wire-partial');
  return text === ''
    ? []
    : text
        .slice(0, -1)
        .split('\n')
        .map((line, index) => {
          const envelope = object(JSON.parse(line));
          requireWorkflow(
            envelope.seq === index + 1 &&
              ['send', 'recv'].includes(String(envelope.side)) &&
              typeof envelope.raw === 'string',
            'h05-wire-envelope',
          );
          return {
            envelope,
            message: object(JSON.parse(envelope.raw as string)),
            ref: { locator: path + '#L' + (index + 1), hash: digest(line + '\n') },
            line: index + 1,
          };
        });
}
export function h05WireSource(ref: InputRef) {
  const match = /^(.*)#L([1-9]\d*)$/u.exec(ref.locator);
  requireWorkflow(match !== null, 'h05-wire-source');
  const entry = h05WireJournal(match[1]!).find((entry) => same(entry.ref, ref));
  requireWorkflow(entry !== undefined, 'h05-wire-source-pin');
  return entry;
}
function verifyRead(value: Record<string, unknown>, journals: InputRef[]) {
  const sent = h05WireSource(value.requestSource as InputRef),
    received = h05WireSource(value.responseSource as InputRef);
  const source = (ref: InputRef) => ref.locator.slice(0, ref.locator.lastIndexOf('#L'));
  requireWorkflow(
    sent.envelope.side === 'send' &&
      received.envelope.side === 'recv' &&
      sent.line < received.line &&
      source(sent.ref) === source(received.ref) &&
      journals.some((ref) => ref.locator === source(sent.ref)) &&
      Number.isSafeInteger(sent.message.id) &&
      received.message.id === sent.message.id &&
      sent.message.method === value.method &&
      same(sent.message.params, value.params) &&
      !('error' in received.message) &&
      same(received.message.result, value.response),
    'h05-wire-rpc',
  );
}
export function readH05State(ref: InputRef, binding: InputRef) {
  const image = json(ref);
  requireWorkflow(
    image.kind === 'comparison-h05-state' &&
      same(image.binding, binding) &&
      typeof image.text === 'string',
    'h05-state-binding',
  );
  const source = object(image.source);
  requireWorkflow(source.hash === digest(image.text), 'h05-state-bytes');
  const run = object(JSON.parse(image.text)) as unknown as LocalRun;
  requireWorkflow(localRunVersionSupported(run), 'h05-state-format');
  return run;
}
function refused(run: LocalRun, event: LocalEvent, error: unknown) {
  let actual: string | null = null;
  try {
    applyLocalEvent(run, event);
  } catch (failure) {
    actual = (failure as Error).message;
  }
  requireWorkflow(actual !== null && actual === error, 'h05-refusal-unconfirmed');
}

/** Pure primary replay for the series. It never sends RPC, restarts a process, or changes an owner. */
export function verifyH05Primary(bindingRef: InputRef, report: H05CaseReport) {
  const binding = json(bindingRef) as unknown as H05Binding;
  requireWorkflow(
    binding.kind === 'comparison-h05-binding' &&
      binding.schemaVersion === 1 &&
      binding.opId === report.opId &&
      binding.engine === report.engine &&
      binding.session.id === report.session &&
      binding.turn === report.turn &&
      binding.identity.generation >= 2 &&
      same(report.binding, bindingRef),
    'h05-binding',
  );
  requireWorkflow(
    same(Object.keys(report.checks).sort(), [...h05ProbeIds].sort()) &&
      Object.values(report.checks).every((value) => value === true) &&
      report.outcome === 'accepted' &&
      report.qualification === false &&
      report.nativeAcceptance === false &&
      report.partialScope === true,
    'h05-checks',
  );
  h01ReadPin(binding.material);
  requireWorkflow(
    report.native.journals.length === 2 &&
      same(
        report.native.journals.map((ref) => ref.locator),
        ['h05-initial', 'h05-recovery'].map((label) =>
          join(binding.evidenceRoot, 'native-rpc-' + label, 'primary.jsonl'),
        ),
      ),
    'h05-wire-journals',
  );
  report.native.journals.forEach(h01ReadPin);
  const wire = report.native.journals.flatMap((ref) => h05WireJournal(ref.locator));
  const created = wire.filter(
      (row) => row.envelope.side === 'send' && row.message.method === 'thread/start',
    ),
    sent = wire.filter(
      (row) => row.envelope.side === 'send' && row.message.method === 'turn/start',
    );
  requireWorkflow(created.length === 1 && sent.length === 1, 'h05-one-dispatch');
  const responseTo = (request: (typeof wire)[number]) => {
    const file = request.ref.locator.slice(0, request.ref.locator.lastIndexOf('#L'));
    const answers = wire.filter(
      (row) =>
        row.envelope.side === 'recv' &&
        row.ref.locator.startsWith(file + '#L') &&
        row.message.id === request.message.id,
    );
    requireWorkflow(
      answers.length === 1 && !('error' in answers[0]!.message),
      'h05-dispatch-response',
    );
    return object(answers[0]!.message.result);
  };
  const creation = responseTo(created[0]!),
    nativeCreated = object(creation.thread),
    started = responseTo(sent[0]!);
  requireWorkflow(
    nativeCreated.id === binding.session.id &&
      Array.isArray(nativeCreated.turns) &&
      nativeCreated.turns.length === 0 &&
      creation.model === binding.session.model &&
      creation.reasoningEffort === binding.session.effort &&
      creation.cwd === binding.workspace &&
      object(creation.sandbox).type === 'readOnly' &&
      object(creation.sandbox).networkAccess === false &&
      object(sent[0]!.message.params).threadId === binding.session.id &&
      object(started.turn).id === binding.turn,
    'h05-dispatch-binding',
  );
  const sourceSession = object(
    decodeChatArtifact(binding.evidenceRoot, h01ReadPin(binding.session.receipt).toString('utf8')),
  );
  requireWorkflow(
    sourceSession.operation === 'thread/start' && same(sourceSession.session, creation),
    'h05-session-primary',
  );
  const failure = json(binding.failure),
    check = json(failure.check as InputRef),
    stop = object(check.stop);
  requireWorkflow(
    failure.kind === 'comparison-h05-initial-failure' &&
      check.kind === 'comparison-h05-check' &&
      check.opId === binding.opId &&
      check.requestHash === binding.requestHash &&
      same(check.material, binding.material) &&
      check.cwd === binding.workspace &&
      check.passed === false &&
      stop.stopped === true &&
      Number.isInteger(stop.code) &&
      Number(stop.code) > 0 &&
      stop.signal === null &&
      stop.killed === false &&
      stop.deadlineReached === false,
    'h05-original-failure',
  );
  h01ReadPin(check.stdout as InputRef);
  h01ReadPin(check.stderr as InputRef);
  const initial = readH05State(report.initial.state!, bindingRef),
    final = readH05State(report.retained.after!, bindingRef);
  requireWorkflow(
    same(report.initial.failure, binding.failure) &&
      same(report.retained.before, report.initial.state),
    'h05-initial-binding',
  );
  requireWorkflow(
    initial.spec.writer === binding.identity.owner &&
      initial.generation === binding.identity.generation &&
      initial.spec.session_id === binding.session.id &&
      initial.status === 'waiting' &&
      initial.results.some(
        (result) => result.outcome === 'FAIL' && same(result.source, binding.failure),
      ),
    'h05-initial-owner',
  );
  const primary = json(report.native.primary),
    thread = object(object(primary.response).thread),
    turns = (thread.turns as unknown[]).map(object),
    turn = turns.find((value) => value.id === binding.turn);
  verifyRead(primary, report.native.journals);
  requireWorkflow(
    primary.kind === 'comparison-h05-primary-read' &&
      primary.opId === binding.opId &&
      primary.method === 'thread/read' &&
      same(primary.params, { threadId: binding.session.id, includeTurns: true }) &&
      thread.id === binding.session.id &&
      turns.filter((value) => value.id === binding.turn).length === 1 &&
      turn?.status === 'completed',
    'h05-primary-turn',
  );
  const loaded = object(
      decodeChatArtifact(binding.evidenceRoot, h01ReadPin(report.initial.load!).toString('utf8')),
    ),
    expectedRefs = [...binding.query.procedures, ...binding.query.rules].map(
      ({ locator, hash }) => ({ locator, hash }),
    );
  requireWorkflow(
    loaded.session === binding.session.id &&
      loaded.turn === binding.turn &&
      same(loaded.refs, expectedRefs) &&
      same(loaded.observation, turn) &&
      same(initial.loaded?.native, report.initial.load) &&
      same(initial.spec.rules, binding.query.rules) &&
      same(initial.spec.procedures, binding.query.procedures),
    'h05-initial-load',
  );
  confirmNativeRead(object(loaded.observation), expectedRefs);
  confirmNativeRead(turn!, [...expectedRefs, ...binding.query.sources]);
  const messages = (turn!.items as unknown[])
      .map(object)
      .filter((item) => item.type === 'agentMessage'),
    last = messages.at(-1);
  requireWorkflow(last !== undefined && typeof last.text === 'string', 'h05-native-answer');
  const primaryAnswer = object(JSON.parse(last!.text as string));
  validateDataAnswer(
    { query: binding.query } as DataReading,
    { ...primaryAnswer, evidence: report.native.primary } as unknown as DataAnswer,
  );
  requireWorkflow(
    primaryAnswer.outcome === 'PASS' &&
      primaryAnswer.coverage === 'complete' &&
      primaryAnswer.continuation === null,
    'h05-native-answer',
  );
  const prefixBefore = json(report.native.prefixBefore),
    prefixAfter = json(report.native.prefixAfter);
  requireWorkflow(
    prefixBefore.kind === 'comparison-h05-native-prefix' &&
      prefixAfter.kind === prefixBefore.kind &&
      prefixBefore.transcript === binding.nativeTranscript &&
      prefixBefore.transcript === prefixAfter.transcript &&
      typeof prefixBefore.content === 'string' &&
      typeof prefixAfter.content === 'string' &&
      prefixAfter.content.startsWith(prefixBefore.content) &&
      prefixBefore.hash === digest(prefixBefore.content) &&
      prefixAfter.hash === digest(prefixAfter.content),
    'h05-primary-prefix',
  );
  const currentNative = h01RawFile(binding.nativeTranscript);
  for (const prefix of [prefixBefore, prefixAfter]) {
    requireWorkflow(
      currentNative
        .subarray(0, Buffer.byteLength(prefix.content as string))
        .equals(Buffer.from(prefix.content as string)),
      'h05-native-source',
    );
    const lines = (prefix.content as string)
      .trimEnd()
      .split('\n')
      .map((line) => object(JSON.parse(line)));
    const starts = lines.filter(
      (line) => line.type === 'event_msg' && object(line.payload).type === 'task_started',
    );
    const meta = lines.filter((line) => line.type === 'session_meta'),
      ends = lines.filter(
        (line) => line.type === 'event_msg' && object(line.payload).type === 'task_complete',
      );
    requireWorkflow(
      meta.length === 1 &&
        object(meta[0]!.payload).id === binding.session.id &&
        object(meta[0]!.payload).cwd === binding.workspace &&
        starts.length === 1 &&
        object(starts[0]!.payload).turn_id === binding.turn &&
        ends.length === 1 &&
        object(ends[0]!.payload).turn_id === binding.turn,
      'h05-one-native-turn',
    );
    const nativeAnswers = lines
      .filter(
        (line) =>
          line.type === 'response_item' &&
          object(line.payload).type === 'message' &&
          object(line.payload).role === 'assistant',
      )
      .flatMap((line) => {
        const content = object(line.payload).content;
        return Array.isArray(content)
          ? [
              content
                .map(object)
                .map((part) => (typeof part.text === 'string' ? part.text : ''))
                .join(''),
            ]
          : [];
      });
    requireWorkflow(
      nativeAnswers.some((text) => {
        try {
          return same(JSON.parse(text), primaryAnswer);
        } catch {
          return false;
        }
      }),
      'h05-native-answer-source',
    );
  }
  let previous = initial;
  for (const id of h05ProbeIds) {
    const probe = report.probes[id];
    requireWorkflow(probe !== undefined, 'h05-probe-missing');
    const before = readH05State(probe.before, bindingRef),
      after = readH05State(probe.after, bindingRef),
      basis = json(probe.basis),
      observation = json(probe.observation);
    requireWorkflow(
      same(before, previous) &&
        basis.kind === 'comparison-h05-delivery' &&
        basis.id === id &&
        same(basis.binding, bindingRef) &&
        observation.kind === 'comparison-h05-event' &&
        observation.id === id &&
        same(observation.binding, bindingRef),
      'h05-probe-binding',
    );
    const terminal = json(basis.terminal as InputRef),
      message = object(terminal.message),
      params = object(message.params);
    const rawTerminal = h05WireSource(terminal.source as InputRef);
    requireWorkflow(
      rawTerminal.ref.locator.startsWith(report.native.journals[0]!.locator + '#L') &&
        rawTerminal.envelope.side === 'recv' &&
        same(rawTerminal.message, message),
      'h05-wire-notification',
    );
    requireWorkflow(
      terminal.kind === 'comparison-h05-native-notification' &&
        message.method === 'turn/completed' &&
        params.threadId === binding.session.id &&
        object(params.turn).id === binding.turn,
      'h05-primary-notification',
    );
    const deliveries = basis.delivered as InputRef[];
    if (id === 'pre-subscription')
      requireWorkflow(
        basis.subscription === 'after-delivery' && same(deliveries, [basis.terminal]),
        'h05-pre-subscription',
      );
    if (id === 'delivery-recovered')
      requireWorkflow(
        deliveries.length === 0 && probe.reads.some((ref) => json(ref).phase === 'reconcile'),
        'h05-lost-notification',
      );
    if (id === 'deduplicated')
      requireWorkflow(
        basis.subscription === 'before-delivery' &&
          same(deliveries, [basis.terminal, basis.terminal]),
        'h05-duplicate',
      );
    if (id === 'reordered') {
      const progress = json(basis.progress as InputRef);
      const rawProgress = h05WireSource(progress.source as InputRef);
      requireWorkflow(
        rawProgress.ref.locator.startsWith(report.native.journals[0]!.locator + '#L') &&
          rawProgress.envelope.side === 'recv' &&
          same(rawProgress.message, progress.message) &&
          rawProgress.line < rawTerminal.line,
        'h05-wire-progress',
      );
      requireWorkflow(
        same(deliveries, [basis.terminal, basis.progress]) &&
          Number(progress.sequence) < Number(terminal.sequence) &&
          object(progress.message).method !== 'turn/completed',
        'h05-reordered',
      );
      const progressParams = object(object(progress.message).params);
      requireWorkflow(
        progressParams.threadId === binding.session.id && progressParams.turnId === binding.turn,
        'h05-progress-target',
      );
    }
    for (const ref of probe.reads) {
      const read = json(ref),
        value = object(object(read.response).thread),
        found = (value.turns as unknown[]).map(object).find((value) => value.id === binding.turn);
      verifyRead(read, report.native.journals);
      requireWorkflow(
        read.kind === 'comparison-h05-primary-read' &&
          read.id === id &&
          read.method === 'thread/read' &&
          same(read.params, { threadId: binding.session.id, includeTurns: true }) &&
          value.id === binding.session.id &&
          same(found, turn),
        'h05-primary-reconciliation',
      );
    }
    if (id === 'owner-fenced') {
      const attempts = observation.attempts as { event: LocalEvent; error: string }[];
      requireWorkflow(
        attempts.length === 2 &&
          attempts[0]!.event.type === 'RESULT' &&
          attempts[0]!.error === 'stale-event' &&
          attempts[0]!.event.generation === binding.identity.generation - 1 &&
          attempts[0]!.event.generation > 0 &&
          attempts[1]!.event.type === 'RESULT' &&
          attempts[1]!.error === 'wrong-result-identity' &&
          attempts[1]!.event.session_id !== binding.session.id &&
          same(before, after),
        'h05-owner-fence',
      );
      for (const attempt of attempts) refused(before, attempt.event, attempt.error);
    } else if (id === 'late-cancel-refused') {
      const cancel = observation.cancel as LocalEvent,
        late = observation.late as LocalEvent;
      requireWorkflow(
        cancel.type === 'CANCEL' &&
          same(applyLocalEvent(before, cancel), after) &&
          after.status === 'cancelled' &&
          after.generation === binding.identity.generation + 1 &&
          probe.execution?.outcome === 'cancelled' &&
          probe.execution.result === null &&
          probe.result === null &&
          same(deliveries, [basis.terminal]) &&
          probe.reads.length === 0 &&
          late.type === 'RESULT' &&
          late.session_id === binding.session.id &&
          late.generation === binding.identity.generation &&
          same(late.source, report.native.primary) &&
          observation.error === 'run-cancelled',
        'h05-cancel',
      );
      refused(after, late, observation.error);
    } else {
      const event = observation.event as LocalEvent;
      requireWorkflow(
        event.type === 'RESULT' &&
          event.outcome === 'PASS' &&
          event.session_id === binding.session.id &&
          event.generation === binding.identity.generation &&
          same(event.source, probe.result) &&
          same(applyLocalEvent(before, event), after) &&
          probe.execution?.outcome === 'completed' &&
          same(probe.execution.result, probe.result),
        'h05-result-application',
      );
      const result = json(probe.result);
      requireWorkflow(
        result.kind === 'comparison-h05-wait-result' &&
          same(result.binding, bindingRef) &&
          same(result.source, report.native.primary) &&
          same(result.answer, primaryAnswer) &&
          probe.reads.some((ref) => json(ref).phase === 'result'),
        'h05-result',
      );
      probe.execution.evidence.forEach(h01ReadPin);
    }
    previous = after;
  }
  requireWorkflow(
    same(previous, final) &&
      final.results.filter((result) => result.outcome === 'PASS').length === 1 &&
      final.results.filter(
        (result) => result.outcome === 'FAIL' && same(result.source, binding.failure),
      ).length === 1,
    'h05-one-application',
  );
  const waiting = readH05State(report.restart.waiting!, bindingRef),
    restored = readH05State(report.restart.state!, bindingRef),
    resumed = json(report.restart.resumed),
    detached = json(report.restart.detached),
    physical = json(detached.stop as InputRef);
  const recoveryJournal = report.native.journals[1]!,
    resumes = wire.filter(
      (row) => row.envelope.side === 'send' && row.message.method === 'thread/resume',
    );
  requireWorkflow(
    resumes.length === 1 && resumes[0]!.ref.locator.startsWith(recoveryJournal.locator + '#L'),
    'h05-resume-wire',
  );
  const nativeResume = responseTo(resumes[0]!),
    resumeThread = object(nativeResume.thread),
    resumeParams = object(resumes[0]!.message.params),
    resumeReceipt = object(
      decodeChatArtifact(
        binding.evidenceRoot,
        h01ReadPin(resumed.receipt as InputRef).toString('utf8'),
      ),
    ),
    resumeReads = resumed.reads as InputRef[];
  requireWorkflow(
    resumeReceipt.operation === 'thread/resume' &&
      same(resumeReceipt.session, nativeResume) &&
      resumeReceipt.parent === null &&
      resumeThread.id === binding.session.id &&
      resumeThread.path === binding.nativeTranscript &&
      resumeThread.cwd === binding.workspace &&
      resumeThread.projectId === binding.session.native_project_id &&
      resumeThread.parentThreadId === null &&
      resumeThread.forkedFromId === null &&
      nativeResume.cwd === binding.workspace &&
      nativeResume.model === binding.session.model &&
      nativeResume.reasoningEffort === binding.session.effort &&
      object(nativeResume.sandbox).type === 'readOnly' &&
      object(nativeResume.sandbox).networkAccess === false &&
      resumeParams.threadId === binding.session.id &&
      resumeParams.cwd === binding.workspace &&
      resumeParams.sandbox === 'read-only' &&
      resumeParams.approvalPolicy === 'never' &&
      resumeParams.excludeTurns === true &&
      Array.isArray(resumeReads) &&
      resumeReads.length >= 2,
    'h05-resume-binding',
  );
  const recoveredReads = resumeReads.map((ref) => {
    const value = json(ref);
    verifyRead(value, [recoveryJournal]);
    requireWorkflow(
      value.phase === 'resume' && value.id === 'restart-reconciled' && value.opId === binding.opId,
      'h05-resume-read',
    );
    return value;
  });
  requireWorkflow(
    recoveredReads.filter(
      (value) =>
        value.method === 'thread/resume' &&
        same(value.requestSource, resumes[0]!.ref) &&
        same(value.response, nativeResume),
    ).length === 1 &&
      recoveredReads.some(
        (value) =>
          value.method === 'thread/read' &&
          object(value.params).threadId === binding.session.id &&
          object(value.params).includeTurns === true &&
          (object(object(value.response).thread).turns as unknown[]).some((value) => {
            const candidate = object(value);
            return (
              candidate.id === binding.turn &&
              (candidate.items as unknown[])
                .map(object)
                .some(
                  (item) =>
                    item.type === 'userMessage' &&
                    JSON.stringify(item.content).includes(binding.deliveryId),
                )
            );
          }),
      ),
    'h05-recover-known-turn',
  );
  const stopped = json(report.stop);
  const processIdentity = (value: unknown) => {
    const identity = object(value);
    requireWorkflow(
      Number.isSafeInteger(identity.pid) &&
        Number(identity.pid) > 1 &&
        Number.isSafeInteger(identity.parent) &&
        Number(identity.parent) > 0 &&
        typeof identity.started === 'string' &&
        identity.started.length > 0,
      'h05-process-identity',
    );
    return identity;
  };
  const stoppedProcess = (stop: Record<string, unknown>, label: string) => {
    requireWorkflow(
      stop.kind === 'comparison-h05-stop' &&
        stop.opId === binding.opId &&
        stop.confirmed === true &&
        stop.readersStopped === true &&
        stop.transportClosed === true &&
        same(stop.sessions, [binding.session.id]) &&
        same(stop.remainingProcesses, []),
      'h05-physical-stop',
    );
    const receipts = (stop.evidence as InputRef[]).map((ref) => json(ref)),
      starts = receipts.filter((value) => value.kind === 'h02-native-rpc-process'),
      stops = receipts.filter((value) => value.kind === 'h02-native-process-stop');
    requireWorkflow(
      starts.length === 1 &&
        starts[0]!.label === label &&
        stops.length === 1 &&
        stops[0]!.confirmed === true &&
        Array.isArray(stops[0]!.processes),
      'h05-process-stop',
    );
    const initial = processIdentity(starts[0]!.initial),
      terminated = (stops[0]!.processes as unknown[]).map(processIdentity);
    requireWorkflow(
      same(stops[0]!.initial, initial) && terminated.some((value) => same(value, initial)),
      'h05-process-binding',
    );
    return { initial, terminated };
  };
  const oldProcess = stoppedProcess(physical, 'h05-initial'),
    newProcess = stoppedProcess(stopped, 'h05-recovery');
  requireWorkflow(
    !oldProcess.terminated.some((value) => same(value, newProcess.initial)),
    'h05-new-process',
  );
  const detachedCreation = json(detached.creation as InputRef);
  requireWorkflow(
    detached.opId === binding.opId &&
      detached.requestHash === binding.requestHash &&
      detached.turn === binding.turn &&
      detached.transcript === binding.nativeTranscript &&
      detachedCreation.kind === 'h01-native-dispatch' &&
      detachedCreation.method === 'thread/start' &&
      same(detachedCreation.response, creation) &&
      same(detachedCreation.params, created[0]!.message.params),
    'h05-detached-binding',
  );
  requireWorkflow(
    waiting.spec.writer === restored.spec.writer &&
      waiting.generation === restored.generation &&
      waiting.spec.session_id === restored.spec.session_id &&
      waiting.status === 'waiting' &&
      same(waiting, restored) &&
      resumed.kind === 'comparison-h05-resumed' &&
      resumed.session === binding.session.id &&
      resumed.turn === binding.turn &&
      resumed.deliveryId === binding.deliveryId &&
      same(resumed.detached, report.restart.detached) &&
      detached.kind === 'comparison-h05-recovery-binding' &&
      detached.session === binding.session.id &&
      physical.confirmed === true &&
      physical.readersStopped === true &&
      physical.transportClosed === true &&
      same(physical.remainingProcesses, []),
    'h05-restart',
  );
  requireWorkflow(
    stopped.kind === 'comparison-h05-stop' &&
      stopped.opId === binding.opId &&
      stopped.confirmed === true &&
      same(stopped.sessions, [binding.session.id]) &&
      same(stopped.remainingProcesses, []) &&
      (stopped.evidence as InputRef[]).some((ref) => same(ref, detached.stop)),
    'h05-stop',
  );
  requireWorkflow(
    initial.spec.sources.some((source) => same(source, bindingRef)) &&
      join(binding.stateRoot, 'assignment.json') ===
        object(json(report.retained.after!).source).locator,
    'h05-persisted-wait',
  );
  h01ReadPin(object(json(report.retained.after!).source) as unknown as InputRef);
  return { binding, session: binding.session.id, turn: binding.turn, initial, final };
}
